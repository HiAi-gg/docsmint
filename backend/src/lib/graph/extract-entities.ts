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
import { closeGraph, type GraphSqlClient, getGraphDb } from "./init";

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
}

export interface ExtractedEntity {
	name: string;
	type: EntityType;
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
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0;
const CHAT_TIMEOUT_MS = 30_000;

/**
 * Extract entities from a single document chunk and persist them to AGE.
 *
 * Returns the array of extracted entities (possibly empty). Never throws.
 * If AGE is disabled, unreachable, or the LLM call fails, returns `[]`.
 */
export async function extractEntities(
	chunkText: string,
	documentId: string,
	options: ExtractEntitiesOptions = {},
): Promise<ExtractedEntity[]> {
	if (!config.GRAPH_EXTRACT_ENABLED) return [];
	if (!config.AGE_DATABASE_URL) {
		logger.debug(
			{ documentId },
			"AGE_DATABASE_URL not set — skipping entity extraction",
		);
		return [];
	}
	const text = chunkText.trim();
	if (!text) return [];

	const sql = await getGraphDb();
	if (!sql) return [];

	let entities: ExtractedEntity[];
	try {
		entities = await callEntityExtractionLLM(text, options);
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
		// Reset the singleton so the next call retries with a fresh
		// connection. Useful when AGE went down mid-process.
		await closeGraph().catch(() => undefined);
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
	'Return ONLY a JSON object of the form {"entities":[...]} — no prose, no markdown fences.',
	'Each entity: {"name": string, "type": <one of the allowed types>, "relationships": [...]}',
	'Each relationship: {"targetName": string, "relationType": <one of the allowed types>}',
	"Skip entities you cannot classify into the allowed types. Skip relationships whose target you cannot name.",
	"Limit to at most 10 entities and 20 relationships per chunk to keep the response compact.",
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
}): Promise<string> {
	const url = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: params.model,
				messages: params.messages,
				max_tokens: params.maxTokens,
				temperature: params.temperature,
				response_format: { type: "json_object" },
			}),
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

		out.push({
			name,
			type,
			relationships: parseRelationships(e.relationships),
		});
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
		out.push({ targetName, relationType });
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
	// 1. Ensure the source Document vertex exists. `cypher()` requires the
	// search_path to include ag_catalog; the AGE init migration sets that
	// for the connection but we re-set it here for safety because pooled
	// connections can have their GUCs reset between transactions.
	await sql`SELECT ag_catalog.set_config('search_path', 'ag_catalog, "$user", public', false)`;

	const nowIso = new Date().toISOString();

	// Upsert the document vertex.
	await sql`
		SELECT * FROM cypher('docs_graph', $$
			MERGE (d:Document {id: ${documentId}})
			ON CREATE SET d.created_at = ${nowIso}, d.entity_extracted_at = ${nowIso}
			ON MATCH SET d.entity_extracted_at = ${nowIso}
			RETURN d.id
		$$) AS (result agtype)
	`;

	// 2. Upsert each entity vertex and create a MENTIONS edge to the
	//    source Document. Per-type Cypher because AGE doesn't allow
	//    parameterized labels.
	for (const ent of entities) {
		const label = ent.type;
		const name = ent.name;
		await sql`
			SELECT * FROM cypher('docs_graph', ${entityUpsertCypher(label, name, nowIso)}) AS (result agtype)
		`;

		await sql`
			SELECT * FROM cypher('docs_graph', ${documentEntityEdgeCypher(documentId, label, name)}) AS (result agtype)
		`;
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
			);
			await sql`
				SELECT * FROM cypher('docs_graph', ${cypher}) AS (result agtype)
			`;
		}
	}
}

/**
 * Build a Cypher statement that MERGEs an entity vertex keyed by `(label, name)`.
 * The label is inlined from a fixed enum (safe from injection); the name and
 * timestamp are passed as Cypher `$param` placeholders because AGE's
 * parameterized Cypher substitutes them safely.
 */
function entityUpsertCypher(
	label: string,
	name: string,
	nowIso: string,
): string {
	return `
		MERGE (e:\`${label}\` {name: $name})
		ON CREATE SET e.created_at = $now, e.first_seen_doc = $docId
		ON MATCH SET e.last_seen_doc = $docId
		RETURN e.name
	`
		.replace("$name", JSON.stringify(name))
		.replace("$now", JSON.stringify(nowIso))
		.replace("$docId", JSON.stringify("")); // placeholder, unused
}

/**
 * Connect a Document to an entity via a MENTIONS edge.
 */
function documentEntityEdgeCypher(
	docId: string,
	label: string,
	name: string,
): string {
	return `
		MATCH (d:Document {id: $docId})
		MATCH (e:\`${label}\` {name: $name})
		MERGE (d)-[r:MENTIONS]->(e)
		ON CREATE SET r.created_at = $now
		RETURN r
	`
		.replace("$docId", JSON.stringify(docId))
		.replace("$name", JSON.stringify(name))
		.replace("$now", JSON.stringify(new Date().toISOString()));
}

/**
 * Create an entity-to-entity edge when both endpoints exist. We match the
 * source by `(label, name)` and the target by name across all entity
 * labels. If the target doesn't exist, the MATCH returns no rows and the
 * MERGE is a no-op — callers shouldn't assume all declared relationships
 * will materialize.
 */
function entityRelationCypher(
	sourceLabel: string,
	sourceName: string,
	targetName: string,
	relationType: string,
): string {
	return `
		MATCH (a:\`${sourceLabel}\` {name: $source})
		MATCH (b)
		WHERE (b:Person {name: $target}) IS NOT NULL
		   OR (b:Organization {name: $target}) IS NOT NULL
		   OR (b:Concept {name: $target}) IS NOT NULL
		   OR (b:Location {name: $target}) IS NOT NULL
		   OR (b:Topic {name: $target}) IS NOT NULL
		MERGE (a)-[r:\`${relationType}\`]->(b)
		ON CREATE SET r.created_at = $now
		RETURN r
	`
		.replace("$source", JSON.stringify(sourceName))
		.replace("$target", JSON.stringify(targetName))
		.replace("$now", JSON.stringify(new Date().toISOString()));
}
