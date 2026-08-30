import { describe, expect, test } from "bun:test";
import {
	CANDIDATE_MODELS,
	CURRENT_CHAT_CHAIN,
	CURRENT_EMBED_CHAIN,
	OPENROUTER_RERANK_URL,
	speedBakeOffIds,
} from "../lib/openrouter-candidate-matrix";
import { OPENROUTER_PUBLIC_BASE_URL } from "../lib/openrouter-public-matrix";

/**
 * Live speed bake-off against the shipped primary+2-fallback chain.
 * Hermetic CI excludes this file. It no-ops without a real OpenRouter key.
 */
function liveOpenRouterKey(): string | null {
	const key = process.env.OPENROUTER_API_KEY?.trim() ?? "";
	if (!key || key.startsWith("change-me") || !key.startsWith("sk-or-")) {
		return null;
	}
	return key;
}

const EXTRACT_USER = [
	"DocsMint stores TipTap JSON as canonical content.",
	"Alice from Acme Corp authored the Architecture guide in Berlin.",
	"GraphRAG extraction writes Person, Organization, Concept, Location, and Topic nodes.",
].join(" ");

const EXPAND_USER = JSON.stringify({
	query: "английский язык",
	locale: "ru",
});

const RERANK_DOCS = [
	"English language settings and locale detection for the editor.",
	"French translation of the onboarding checklist.",
	"Architecture: hybrid search fuses exact, FTS, fuzzy, vector, and graph channels.",
	"SeaweedFS stores attachment bytes; embeddings live in pgvector.",
	"Категории документов не должны смешиваться с тегами.",
	"Redis deduplicates re-embed jobs for five seconds.",
	"The public share token never includes owner_id.",
	"A cooking recipe for sourdough bread.",
];

interface TimedResult {
	model: string;
	task: string;
	ok: boolean;
	status: number;
	ms: number;
	detail: string;
}

async function timed(
	model: string,
	task: string,
	run: () => Promise<{ ok: boolean; status: number; detail: string }>,
): Promise<TimedResult> {
	const started = performance.now();
	try {
		const result = await run();
		return { model, task, ms: performance.now() - started, ...result };
	} catch (error) {
		return {
			model,
			task,
			ok: false,
			status: 0,
			ms: performance.now() - started,
			detail: error instanceof Error ? error.message.slice(0, 180) : "error",
		};
	}
}

describe("live OpenRouter speed matrix", () => {
	test("skips without a real OPENROUTER_API_KEY", () => {
		if (liveOpenRouterKey()) return;
		expect(liveOpenRouterKey()).toBeNull();
	});

	test("times embed, extract, expand, and rerank against the current chain", async () => {
		const apiKey = liveOpenRouterKey();
		if (!apiKey) return;

		const headers = {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/HiAi-gg/docsmint",
			"X-Title": "DocsMint candidate speed matrix",
		};
		const bakeOff = speedBakeOffIds();
		const rows: TimedResult[] = [];

		for (const model of bakeOff.embed) {
			rows.push(
				await timed(model, "embed_query", async () => {
					const response = await fetch(
						`${OPENROUTER_PUBLIC_BASE_URL}/embeddings`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								model,
								input: "английский язык",
								dimensions: 1024,
							}),
						},
					);
					const body = (await response.json()) as {
						data?: Array<{ embedding?: number[] }>;
						error?: { message?: string };
					};
					const dims = body.data?.[0]?.embedding?.length ?? 0;
					return {
						ok: response.ok && dims === 1024,
						status: response.status,
						detail: response.ok
							? `${dims}d`
							: (body.error?.message ?? "embed failed"),
					};
				}),
			);
		}

		const chatModels = [...new Set([...CURRENT_CHAT_CHAIN, ...bakeOff.chat])];
		for (const model of chatModels) {
			const candidate = CANDIDATE_MODELS.find((item) => item.id === model);
			const reasoning =
				candidate?.reasoning === "mandatory"
					? { reasoning: { effort: "minimal" } }
					: { reasoning: { effort: "none" } };
			const jsonFormat =
				candidate?.jsonFit === "plain"
					? {}
					: { response_format: { type: "json_object" } };

			rows.push(
				await timed(model, "extract_entities", async () => {
					const response = await fetch(
						`${OPENROUTER_PUBLIC_BASE_URL}/chat/completions`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								model,
								temperature: 0,
								max_tokens: 256,
								...jsonFormat,
								...reasoning,
								messages: [
									{
										role: "system",
										content:
											'Return JSON only: {"entities":[{"name":"","type":"Person|Organization|Concept|Location|Topic","confidence":0.9}]}',
									},
									{ role: "user", content: EXTRACT_USER },
								],
							}),
						},
					);
					const body = (await response.json()) as {
						choices?: Array<{ message?: { content?: string } }>;
						error?: { message?: string };
					};
					const content = body.choices?.[0]?.message?.content ?? "";
					const hasEntities = content.includes("entities");
					return {
						ok: response.ok && hasEntities,
						status: response.status,
						detail: response.ok
							? hasEntities
								? "json"
								: "no-entities"
							: (body.error?.message ?? "chat failed"),
					};
				}),
			);

			rows.push(
				await timed(model, "expand_query", async () => {
					const response = await fetch(
						`${OPENROUTER_PUBLIC_BASE_URL}/chat/completions`,
						{
							method: "POST",
							headers,
							body: JSON.stringify({
								model,
								temperature: 0,
								max_tokens: 192,
								...jsonFormat,
								...reasoning,
								messages: [
									{
										role: "system",
										content:
											"Return JSON only with arrays named translations, synonyms, concepts, and namedEntities.",
									},
									{ role: "user", content: EXPAND_USER },
								],
							}),
						},
					);
					const body = (await response.json()) as {
						choices?: Array<{ message?: { content?: string } }>;
						error?: { message?: string };
					};
					const content = body.choices?.[0]?.message?.content ?? "";
					const okJson = content.includes("translations");
					return {
						ok: response.ok && okJson,
						status: response.status,
						detail: response.ok
							? okJson
								? "json"
								: "no-translations"
							: (body.error?.message ?? "chat failed"),
					};
				}),
			);
		}

		for (const model of bakeOff.rerank) {
			rows.push(
				await timed(model, "rerank_fused_hits", async () => {
					const response = await fetch(OPENROUTER_RERANK_URL, {
						method: "POST",
						headers,
						body: JSON.stringify({
							model,
							query: "английский язык",
							documents: RERANK_DOCS,
							top_n: 5,
						}),
					});
					const body = (await response.json()) as {
						results?: Array<{ index: number; relevance_score: number }>;
						error?: { message?: string };
					};
					const ranked = body.results ?? [];
					return {
						ok: response.ok && ranked.length > 0,
						status: response.status,
						detail: response.ok
							? `n=${ranked.length}`
							: (body.error?.message ?? "rerank failed"),
					};
				}),
			);
		}

		const byTask = new Map<string, TimedResult[]>();
		for (const row of rows) {
			const list = byTask.get(row.task) ?? [];
			list.push(row);
			byTask.set(row.task, list);
		}
		for (const [task, list] of byTask) {
			const currentIds = new Set<string>([
				...CURRENT_EMBED_CHAIN,
				...CURRENT_CHAT_CHAIN,
			]);
			const baseline = list.filter((row) => currentIds.has(row.model));
			const fastestOk = [...list]
				.filter((row) => row.ok)
				.sort((a, b) => a.ms - b.ms)[0];
			console.log(
				`[speed-matrix] ${task} baseline_ok=${baseline.filter((row) => row.ok).length}/${baseline.length} fastest=${fastestOk?.model ?? "none"} ${fastestOk ? fastestOk.ms.toFixed(0) : "-"}ms`,
			);
			for (const row of list.sort((a, b) => a.ms - b.ms)) {
				console.log(
					`  ${row.ok ? "ok" : "fail"} ${row.ms.toFixed(0)}ms ${row.status} ${row.model} ${row.detail}`,
				);
			}
		}

		expect(rows.length).toBeGreaterThan(0);
		const currentEmbed = rows.filter(
			(row) =>
				row.task === "embed_query" &&
				(CURRENT_EMBED_CHAIN as readonly string[]).includes(row.model),
		);
		expect(currentEmbed.some((row) => row.ok)).toBe(true);
	}, 240_000);
});
