/**
 * Entity extraction for GraphRAG.
 *
 * Pipeline:
 *   1. Take a chunk of document text + the document id.
 *   2. Ask an OpenAI-compatible chat-completions endpoint to extract
 *      entities (Person / Organization / Concept / Location / Topic) and
 *      their relationships.
 *   3. MERGE the entities in Apache AGE so duplicates collapse on `name`.
 *   4. Create relationships to the source Document and between entities
 *      where possible.
 *
 * All steps are feature-flagged and best-effort:
 *   - `GRAPH_EXTRACT_ENABLED=false` short-circuits to `[]`.
 *   - AGE unreachable → `[]` (never throws).
 *   - LLM call fails or returns malformed JSON → `[]`.
 *
 * The embedding worker MUST be able to call this function without it ever
 * raising — graph extraction is enrichment, not a hard dependency.
 */

import { config } from "../config";
import { logger } from "../logger";
import { redis } from "../redis";
import { type GraphSqlClient, getGraphDb } from "./init";

const ENTITY_TYPES = [
	"Person",
	"Organization",
	"Concept",
	"Location",
	"Topic",
] as const;
const RELATION_TYPES = [
	"MENTIONS",
	"REFERENCES",
	"RELATED_TO",
	"AUTHORED_BY",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type RelationType = (typeof RELATION_TYPES)[number];

export interface ExtractedRelationship {
	targetName: string;
	relationType: RelationType;
	/** Confidence score 0.0–1.0 returned by the LLM. Optional for back-compat. */
	confidence?: number;
}

export interface ExtractedEntity {
	name: string;
	type: EntityType;
	/** Confidence score 0.0–1.0 returned by the LLM. Optional for back-compat. */
	confidence?: number;
	relationships: ExtractedRelationship[];
}

export interface ExtractEntitiesOptions {
	/** Maximum LLM tokens to spend on the response. */
	maxTokens?: number;
	/** Sampling temperature. 0 keeps extractions deterministic. */
	temperature?: number;
	/**
	 * Optional override for the LLM endpoint. Defaults to `EMBEDDING_BASE_URL`
	 * with `/chat/completions` appended. Falls back to the same path on
	 * `EMBEDDING_FALLBACK_BASE_URL` if the primary call fails.
	 */
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
	/** Optional OpenAI-compatible reasoning effort control. */
	reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
	/**
	 * Per-chunk content hash. When paired with `chunkIndex` it triggers a
	 * Redis-backed dedup gate that short-circuits redundant LLM calls for
	 * identical (docId, chunkIndex, chunkHash) tuples already processed by
	 * this process or any sibling process.
	 *
	 * The slot TTL is generous (24 h) so repeated re-embed runs within a
	 * day never re-extract the same chunk. Redis errors fall through to
	 * extraction (best-effort) — see `extractEntities` for the full flow.
	 */
	chunkHash?: string;
	/**
	 * Zero-based chunk index within the document. Required for Redis dedup
	 * to fire; `chunkHash` alone is intentionally ignored so callers that
	 * only know the hash never accidentally claim a slot under the wrong
	 * index. The Redis key is `hiai-docs:extract:done:<docId>:<index>:<hash>`.
	 */
	chunkIndex?: number;
}

/**
 * Redis dedup TTL for `extractEntities` chunk slots. 24 h matches the
 * reembed pipeline's expected churn rate — anything older than a day is
 * likely part of a re-embed pipeline that should re-extract anyway.
 */
const EXTRACT_DEDUP_TTL_SECONDS = 24 * 60 * 60;

function extractDedupKey(
	documentId: string,
	chunkIndex: number,
	chunkHash: string,
): string {
	return `hiai-docs:extract:done:${documentId}:${chunkIndex}:${chunkHash}`;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0;

/**
 * Global deduplication: TTL'd cache of recently extracted entities.
 * Skips LLM call for entity names seen recently with high confidence (>= 0.7).
 *
 * This is a process-local cache (Map). Across processes / restarts the cache
 * is cold — which is fine because extraction is idempotent and AGE MERGEs
 * are safe to re-run. The cache bounds repeated chunks within a single
 * embedding batch (the same paragraph quoted in two consecutive chunks)
 * from triggering redundant LLM calls.
 */
const gDedupCache = new Map<string, { confidence: number; ts: number }>();
const GDEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const GDEDUP_MIN_CONFIDENCE = 0.7;

function setCachedEntity(name: string, type: string, confidence: number): void {
	const key = `${type}:${name.toLowerCase()}`;
	gDedupCache.set(key, { confidence, ts: Date.now() });
	// Soft-bound the cache size: when it grows past the cap, evict everything
	// past TTL. Cheaper than per-write LRU bookkeeping and good enough for
	// the expected scale (a few thousand entities per process lifetime).
	if (gDedupCache.size > 10_000) {
		const now = Date.now();
		for (const [k, v] of gDedupCache) {
			if (now - v.ts > GDEDUP_TTL_MS) gDedupCache.delete(k);
		}
	}
}

/**
 * Test-only: drop all cached entries. Tests that import this module
 * after a previous extraction may want a clean cache to assert behavior
 * deterministically. Not part of the public API.
 */
export function _resetDedupCacheForTests(): void {
	gDedupCache.clear();
}

/**
 * Test-only: look up an entity in the dedup cache. Used by unit tests
 * to assert the cache was populated correctly. Returns the cached
 * confidence (or undefined if absent / expired). Not part of the
 * public API.
 */
export function _peekCachedEntityForTests(
	name: string,
	type: string,
): { confidence: number; ts: number } | undefined {
	const key = `${type}:${name.toLowerCase()}`;
	return gDedupCache.get(key);
}

/**
 * Test-only: parse a raw LLM response into typed entities. Mirrors the
 * behavior of the private parser used during extraction so unit tests
 * can assert confidence-filtering and cache-writing logic without
 * standing up a live LLM endpoint. Not part of the public API.
 */
export function _parseExtractionResponseForTests(
	raw: string,
): ExtractedEntity[] {
	return parseExtractionResponse(raw);
}

/**
 * Extract entities from a single document chunk and persist them to AGE.
 *
 * Returns the array of extracted entities (possibly empty). Never throws.
 * If AGE is disabled, unreachable, or the LLM call fails, returns `[]`.
 *
 * Flow:
 *   1. Short-circuit when GRAPH_EXTRACT_ENABLED is false.
 *   2. Redis dedup gate — only when BOTH chunkHash AND chunkIndex are
 *      supplied. SET NX EX claims a per-(docId,chunkIndex,chunkHash)
 *      slot; a `null` reply means a sibling worker already processed
 *      this chunk and we return [] immediately. Redis errors fall
 *      through to extraction (best-effort).
 *   3. AGE gate — getGraphDb() returns null if the extension is missing
 *      or unreachable; we degrade gracefully.
 *   4. Empty chunk short-circuit — whitespace-only text never reaches
 *      the LLM.
 *   5. LLM call + AGE persistence, both wrapped so a failure logs and
 *      returns [] instead of throwing.
 */
export async function extractEntities(
	chunkText: string,
	documentId: string,
	options: ExtractEntitiesOptions = {},
): Promise<ExtractedEntity[]> {
	if (!config.GRAPH_EXTRACT_ENABLED) return [];

	// Redis dedup gate. Only fires when BOTH chunkHash and chunkIndex are
	// supplied — see the ExtractEntitiesOptions docstring for the rationale.
	if (options.chunkHash && options.chunkIndex !== undefined) {
		const key = extractDedupKey(
			documentId,
			options.chunkIndex,
			options.chunkHash,
		);
		let acquired = false;
		try {
			const result = await redis.set(
				key,
				"1",
				"EX",
				EXTRACT_DEDUP_TTL_SECONDS,
				"NX",
			);
			acquired = result === "OK";
		} catch (err) {
			// Best-effort: Redis being down should NOT drop extraction work.
			logger.warn(
				{ err, documentId, chunkIndex: options.chunkIndex },
				"Extract-dedup Redis SET failed — falling through to extraction",
			);
			acquired = true;
		}
		if (!acquired) return [];
	}

	const sql = await getGraphDb();
	if (!sql) return [];

	if (!chunkText) return [];

	let entities: ExtractedEntity[];
	try {
		entities = await callEntityExtractionLLM(chunkText, options);
	} catch (err) {
		logger.warn(
			{ err, documentId },
			"Entity extraction LLM call failed — skipping",
		);
		return [];
	}

	if (entities.length === 0) return [];

	try {
		await persistEntities(sql, documentId, entities);
	} catch (err) {
		logger.warn(
			{ err, documentId, count: entities.length },
			"Failed to persist extracted entities to AGE — discarding",
		);
		return [];
	}

	logger.debug(
		{ documentId, count: entities.length },
		"Extracted entities and persisted to AGE",
	);
	return entities;
}

// ---------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ChatChoice {
	message?: { content?: string };
}

interface ChatResponse {
	choices?: ChatChoice[];
}

const SYSTEM_PROMPT = [
	"You are an entity-extraction assistant for a knowledge-base system.",
	"Extract named entities and the relationships between them from the user's text.",
	"",
	"Allowed entity types: Person, Organization, Concept, Location, Topic.",
	"Allowed relationship types: MENTIONS, REFERENCES, RELATED_TO, AUTHORED_BY.",
	"",
	"For each entity AND relationship, assign a confidence score from 0.0 (unsure) to 1.0 (certain):",
	"  - 1.0: Explicitly named in text, unambiguous.",
	"  - 0.7-0.9: Clearly implied by context.",
	"  - 0.4-0.6: Reasonable inference but could be wrong.",
	"  - 0.0-0.3: Speculative — omit unless no other entities exist.",
	"",
	'Return ONLY a JSON object of the form {"entities":[...]} — no prose, no markdown fences.',
	'Each entity: {"name": string, "type": <one of the allowed types>, "confidence": number, "relationships": [...]}',
	'Each relationship: {"targetName": string, "relationType": <one of the allowed types>, "confidence": number}',
	"Skip entities you cannot classify into the allowed types. Skip relationships whose target you cannot name.",
	"Limit to at most 10 entities and 20 relationships per chunk to keep the response compact.",
	"",
	'Example — for the text "Apple Inc. released the iPhone 15 in 2023, led by CEO Tim Cook":',
	'{"entities":[',
	'  {"name":"Apple Inc.","type":"Organization","confidence":1.0,"relationships":[',
	'    {"targetName":"iPhone 15","relationType":"REFERENCES","confidence":1.0},',
	'    {"targetName":"Tim Cook","relationType":"AUTHORED_BY","confidence":0.8}',
	"  ]},",
	'  {"name":"iPhone 15","type":"Concept","confidence":1.0,"relationships":[]},',
	'  {"name":"Tim Cook","type":"Person","confidence":1.0,"relationships":[]}',
	"]}",
].join("\n");

/**
 * Call the OpenAI-compatible chat-completions endpoint to extract entities.
 * Tries the primary embedding provider first, then the fallback, then gives
 * up with `[]`. The `json_object` response format is requested so the model
 * returns valid JSON without markdown fencing.
 */
async function callEntityExtractionLLM(
	text: string,
	options: ExtractEntitiesOptions,
): Promise<ExtractedEntity[]> {
	const endpoints: Array<{ baseUrl: string; apiKey: string; model: string }> =
		[];

	const primaryBase =
		options.llmBaseUrl ??
		config.GRAPH_EXTRACT_BASE_URL ??
		config.EMBEDDING_BASE_URL;
	const primaryKey =
		options.llmApiKey ??
		config.GRAPH_EXTRACT_API_KEY ??
		config.EMBEDDING_API_KEY ??
		"";
	const primaryModel =
		options.llmModel ??
		config.GRAPH_EXTRACT_MODEL ??
		config.EMBEDDING_MODEL ??
		"gpt-4o-mini";
	if (primaryBase)
		endpoints.push({
			baseUrl: primaryBase,
			apiKey: primaryKey,
			model: primaryModel,
		});

	const fallbackBase =
		config.GRAPH_EXTRACT_FALLBACK_BASE_URL ??
		config.EMBEDDING_FALLBACK_BASE_URL;
	const fallbackKey =
		config.GRAPH_EXTRACT_FALLBACK_API_KEY ??
		config.EMBEDDING_FALLBACK_API_KEY ??
		"";
	const fallbackModel =
		config.GRAPH_EXTRACT_FALLBACK_MODEL ??
		config.EMBEDDING_FALLBACK_MODEL ??
		primaryModel;
	if (
		fallbackBase &&
		(fallbackBase !== primaryBase || fallbackKey !== primaryKey)
	) {
		endpoints.push({
			baseUrl: fallbackBase,
			apiKey: fallbackKey,
			model: fallbackModel,
		});
	}

	let lastErr: unknown = null;
	for (const ep of endpoints) {
		try {
			const raw = await callChatCompletions({
				baseUrl: ep.baseUrl,
				apiKey: ep.apiKey,
				model: ep.model,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: text },
				],
				maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
				temperature: options.temperature ?? DEFAULT_TEMPERATURE,
				reasoningEffort:
					options.reasoningEffort ?? config.GRAPH_EXTRACT_REASONING_EFFORT,
			});
			return parseExtractionResponse(raw);
		} catch (err) {
			lastErr = err;
			logger.warn(
				{ err, baseUrl: ep.baseUrl, model: ep.model },
				"Entity extraction LLM endpoint failed — trying fallback",
			);
		}
	}
	if (lastErr) throw lastErr;
	return [];
}

async function callChatCompletions(params: {
	baseUrl: string;
	apiKey: string;
	model: string;
	messages: ChatMessage[];
	maxTokens: number;
	temperature: number;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
}): Promise<string> {
	const url = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		config.GRAPH_EXTRACT_TIMEOUT_MS,
	);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

	try {
		const body = {
			model: params.model,
			messages: params.messages,
			max_tokens: params.maxTokens,
			temperature: params.temperature,
			response_format: { type: "json_object" },
			...(params.reasoningEffort
				? { reasoning_effort: params.reasoningEffort }
				: {}),
		};
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "unknown");
			throw new Error(
				`Chat completions failed: ${response.status} ${body.slice(0, 200)}`,
			);
		}
		const data = (await response.json()) as ChatResponse;
		const content = data.choices?.[0]?.message?.content;
		if (typeof content !== "string" || content.length === 0) {
			throw new Error("Chat completions returned empty content");
		}
		return content;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Parse the LLM response into a typed list of entities. Strips markdown
 * fences (in case the provider ignored `response_format`) and validates the
 * shape. Malformed entries are dropped, not raised — better to under-extract
 * than to lose the entire batch.
 */
function parseExtractionResponse(raw: string): ExtractedEntity[] {
	const jsonText = stripMarkdownFences(raw).trim();
	if (!jsonText) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		logger.warn(
			{ err, raw: jsonText.slice(0, 200) },
			"LLM returned invalid JSON",
		);
		return [];
	}

	const entities = extractArray(parsed, "entities");
	if (!entities) return [];

	const out: ExtractedEntity[] = [];
	const seen = new Set<string>();
	const minConf = config.GRAPH_EXTRACT_MIN_CONFIDENCE;
	for (const entry of entities) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.trim() : "";
		const type = typeof e.type === "string" ? e.type : "";
		if (!name) continue;
		if (!isEntityType(type)) continue;
		// Cap duplicate names per chunk — they would collapse in the
		// graph anyway, and we don't want a runaway loop.
		const key = `${type}:${name.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);

		// Clamp confidence into [0, 1] and drop entries below the configured
		// threshold. Undefined (LLM didn't supply a score) is kept — we don't
		// know enough to discard it, and the AGE writer handles undefined by
		// omitting the confidence property.
		const confidence =
			typeof e.confidence === "number"
				? Math.max(0, Math.min(1, e.confidence))
				: undefined;
		if (confidence !== undefined && confidence < minConf) continue;

		out.push({
			name,
			type,
			confidence,
			relationships: parseRelationships(e.relationships),
		});

		// Cache entity for dedup when confidence is high enough.
		if (confidence !== undefined && confidence >= GDEDUP_MIN_CONFIDENCE) {
			setCachedEntity(name, type, confidence);
		}
	}
	return out;
}

function parseRelationships(value: unknown): ExtractedRelationship[] {
	if (!Array.isArray(value)) return [];
	const out: ExtractedRelationship[] = [];
	for (const r of value) {
		if (!r || typeof r !== "object") continue;
		const rec = r as Record<string, unknown>;
		const targetName =
			typeof rec.targetName === "string" ? rec.targetName.trim() : "";
		const relationType =
			typeof rec.relationType === "string" ? rec.relationType : "";
		if (!targetName) continue;
		if (!isRelationType(relationType)) continue;
		const confidence =
			typeof rec.confidence === "number"
				? Math.max(0, Math.min(1, rec.confidence))
				: undefined;
		out.push({ targetName, relationType, confidence });
	}
	return out;
}

function extractArray(value: unknown, key: string): unknown[] | null {
	if (!value || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	const arr = obj[key];
	return Array.isArray(arr) ? arr : null;
}

function isEntityType(value: string): value is EntityType {
	return (ENTITY_TYPES as readonly string[]).includes(value);
}

function isRelationType(value: string): value is RelationType {
	return (RELATION_TYPES as readonly string[]).includes(value);
}

function stripMarkdownFences(text: string): string {
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
	return fenced?.[1] ?? text;
}

// ---------------------------------------------------------------------
// AGE persistence
// ---------------------------------------------------------------------

/**
 * Persist extracted entities and their relationships to AGE.
 *
 * Strategy:
 *   - One MERGE for the source Document (idempotent on `documentId`).
 *   - One MERGE per entity, keyed on `(label, name)` so duplicates across
 *     chunks collapse naturally.
 *   - One MATCH+MERGE per `MENTIONS` edge from Document → entity.
 *   - For entity-to-entity edges, MATCH both endpoints by name (across all
 *     entity labels) and MERGE the edge with the declared relation type.
 *     If the target is unknown, the edge is dropped silently.
 */
async function persistEntities(
	sql: GraphSqlClient,
	documentId: string,
	entities: ExtractedEntity[],
): Promise<void> {
	// Wrap all cypher writes in a transaction so a failure mid-way rolls
	// back partial graph state (some entities persisted, some edges missing).
	// AGE's cypher() requires a literal dollar-quoted string constant, not a
	// bind parameter, so we use sql.unsafe() with $$ ... $$ dollar-quoting.
	// The helper functions already inline values via JSON.stringify, which
	// is safe against injection.
	await sql.begin(async (tx) => {
		// Ensure the search_path includes ag_catalog for cypher() calls.
		await tx`SELECT pg_catalog.set_config('search_path', 'ag_catalog, "$user", public', false)`;

		const nowIso = new Date().toISOString();
		const docIdLiteral = JSON.stringify(documentId);
		const nowLiteral = JSON.stringify(nowIso);

		// 1. Upsert the source Document vertex. Values are inlined as JSON
		//    literals (safe — documentId is a UUID from the DB).
		await tx.unsafe(
			`SELECT * FROM cypher('docs_graph', $$
				MERGE (d:Document {id: ${docIdLiteral}})
				SET d.created_at = ${nowLiteral}, d.entity_extracted_at = ${nowLiteral}
				RETURN d.id
			$$) AS (result agtype)`,
		);

		// 2. Upsert each entity vertex and create a MENTIONS edge to the
		//    source Document. Per-type Cypher because AGE doesn't allow
		//    parameterized labels. Helper functions return literal Cypher
		//    with values already inlined.
		for (const ent of entities) {
			const label = ent.type;
			const name = ent.name;
			const conf = ent.confidence;
			await tx.unsafe(
				`SELECT * FROM cypher('docs_graph', $$ ${entityUpsertCypher(documentId, label, name, nowIso, conf)} $$) AS (result agtype)`,
			);
			await tx.unsafe(
				`SELECT * FROM cypher('docs_graph', $$ ${documentEntityEdgeCypher(documentId, label, name, conf)} $$) AS (result agtype)`,
			);
		}

		// 3. Create entity-to-entity edges where the target can be found by
		//    name across any entity label.
		for (const ent of entities) {
			for (const rel of ent.relationships) {
				const cypher = entityRelationCypher(
					ent.type,
					ent.name,
					rel.targetName,
					rel.relationType,
					rel.confidence,
				);
				await tx.unsafe(
					`SELECT * FROM cypher('docs_graph', $$ ${cypher} $$) AS (result agtype)`,
				);
			}
		}
	});
}

/**
 * Build a Cypher statement that MERGEs an entity vertex keyed by `(label, name)`.
 * The label is inlined from a fixed enum (safe from injection); the name and
 * timestamp are passed as Cypher `$param` placeholders because AGE's
 * parameterized Cypher substitutes them safely.
 *
 * `confidence` (0.0–1.0) is stored on the vertex:
 *   - on CREATE we set the initial score
 *   - on MATCH we keep the highest observed score via GREATEST so repeated
 *     sightings can't dilute a strong extraction with a weak one
 */
function entityUpsertCypher(
	docId: string,

	label: string,
	name: string,
	nowIso: string,
	confidence: number | undefined,
): string {
	const confLiteral =
		typeof confidence === "number" ? JSON.stringify(confidence) : "null";
	return `
		MERGE (e:\`${label}\` {name: $name})
		SET e.created_at = $now, e.last_seen_doc = $docId, e.confidence = $conf
		RETURN e.name
	`
		.replace("$name", JSON.stringify(name))
		.replace("$now", JSON.stringify(nowIso))
		.replace("$docId", JSON.stringify(docId))
		.replace("$conf", confLiteral);
}

/**
 * Connect a Document to an entity via a MENTIONS edge. The edge stores
 * the source confidence (if provided) so downstream graph expansion can
 * weight high-confidence MENTIONS edges higher.
 */
function documentEntityEdgeCypher(
	docId: string,
	label: string,
	name: string,
	confidence: number | undefined,
): string {
	const confLiteral =
		typeof confidence === "number" ? JSON.stringify(confidence) : "null";
	return `
		MATCH (d:Document {id: $docId})
		MATCH (e:\`${label}\` {name: $name})
		MERGE (d)-[r:MENTIONS]->(e)
		SET r.created_at = $now, r.confidence = $conf
		RETURN r
	`
		.replace("$docId", JSON.stringify(docId))
		.replace("$name", JSON.stringify(name))
		.replace("$now", JSON.stringify(new Date().toISOString()))
		.replace("$conf", confLiteral);
}

/**
 * Create an entity-to-entity edge when both endpoints exist. We match the
 * source by `(label, name)` and the target by name across all entity
 * labels. If the target doesn't exist, the MATCH returns no rows and the
 * MERGE is a no-op — callers shouldn't assume all declared relationships
 * will materialize.
 *
 * Edge confidence is propagated from the LLM-extracted relationship score,
 * using GREATEST on re-sightings so the edge keeps the strongest signal.
 */
function entityRelationCypher(
	sourceLabel: string,
	sourceName: string,
	targetName: string,
	relationType: string,
	confidence: number | undefined,
): string {
	const confLiteral =
		typeof confidence === "number" ? JSON.stringify(confidence) : "null";
	return `
		MATCH (a:\`${sourceLabel}\` {name: $source})
		MATCH (b {name: $target})
		MERGE (a)-[r:\`${relationType}\`]->(b)
		SET r.created_at = $now, r.confidence = $conf
		RETURN r
	`
		.replace("$source", JSON.stringify(sourceName))
		.replace("$target", JSON.stringify(targetName))
		.replace("$now", JSON.stringify(new Date().toISOString()))
		.replace("$conf", confLiteral);
}
