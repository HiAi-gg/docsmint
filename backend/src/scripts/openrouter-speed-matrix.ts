/**
 * Live OpenRouter bake-off for DocsMint search jobs.
 * Run: bun --env-file=.env run backend/src/scripts/openrouter-speed-matrix.ts
 * Never prints the API key.
 */
import { mkdir } from "node:fs/promises";
import {
	CANDIDATE_MODELS,
	type CandidateModel,
	OPENROUTER_RERANK_URL,
} from "../lib/openrouter-candidate-matrix";
import { OPENROUTER_PUBLIC_BASE_URL } from "../lib/openrouter-public-matrix";

type Task = "embed" | "extract" | "expand" | "summary" | "rerank";

type Cell = {
	task: Task;
	ok: boolean | null;
	ms: number | null;
	detail: string;
};

const TASKS: Task[] = ["embed", "extract", "expand", "summary", "rerank"];

const EXTRACT_USER = [
	"DocsMint stores TipTap JSON as canonical content.",
	"Alice from Acme Corp authored the Architecture guide in Berlin.",
	"GraphRAG extraction writes Person, Organization, Concept, Location, and Topic nodes.",
].join(" ");

const EXPAND_USER = JSON.stringify({
	query: "английский язык",
	locale: "ru",
});

const SUMMARY_USER =
	"Title: Architecture\n\nHybrid search fuses exact, FTS, fuzzy, vector, and graph channels. Embeddings are 1024-dimensional.";

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

function liveKey(): string {
	const key = process.env.OPENROUTER_API_KEY?.trim() ?? "";
	if (!key || key.startsWith("change-me") || !key.startsWith("sk-or-")) {
		throw new Error("OPENROUTER_API_KEY is missing or still a placeholder");
	}
	return key;
}

function tasksFor(model: CandidateModel): Task[] {
	if (
		model.slot === "embed" ||
		model.id.includes("voyage") ||
		model.id.includes("embed")
	) {
		return ["embed"];
	}
	if (model.slot === "rerank" || model.id.includes("rerank")) {
		return ["rerank"];
	}
	if (model.slot.startsWith("chat_")) {
		return ["extract", "expand", "summary"];
	}
	return [];
}

function parseJson(raw: string): unknown {
	const trimmed = raw.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return JSON.parse(fenced?.[1] ?? trimmed);
}

function headers(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"HTTP-Referer": "https://github.com/HiAi-gg/docsmint",
		"X-Title": "DocsMint local speed matrix",
	};
}

async function requestJson(
	url: string,
	apiKey: string,
	body: unknown,
	timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: headers(apiKey),
			signal: controller.signal,
			body: JSON.stringify(body),
		});
		const json = (await response.json()) as Record<string, unknown>;
		return { status: response.status, json };
	} finally {
		clearTimeout(timer);
	}
}

function errorDetail(json: Record<string, unknown>, status: number): string {
	const err = json.error;
	if (err && typeof err === "object" && "message" in err) {
		return String((err as { message: unknown }).message).slice(0, 160);
	}
	return `http ${status}`;
}

function chatBody(
	model: CandidateModel,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: model.id,
		messages,
		temperature: 0,
		max_tokens: maxTokens,
	};
	if (model.jsonFit !== "plain") {
		body.response_format = { type: "json_object" };
	}
	body.reasoning_effort = model.reasoning === "mandatory" ? "minimal" : "none";
	return body;
}

async function probeEmbed(
	model: CandidateModel,
	apiKey: string,
): Promise<Omit<Cell, "task">> {
	const started = performance.now();
	try {
		const { status, json } = await requestJson(
			`${OPENROUTER_PUBLIC_BASE_URL}/embeddings`,
			apiKey,
			{ model: model.id, input: "английский язык", dimensions: 1024 },
			20_000,
		);
		const data = json.data as Array<{ embedding?: number[] }> | undefined;
		const vector = data?.[0]?.embedding ?? [];
		const finite = vector.every((value) => Number.isFinite(value));
		const nonzero = vector.some((value) => value !== 0);
		const ok = status === 200 && vector.length === 1024 && finite && nonzero;
		return {
			ok,
			ms: performance.now() - started,
			detail: ok
				? "1024-dim"
				: `${errorDetail(json, status)} dim=${vector.length}`,
		};
	} catch (error) {
		return {
			ok: false,
			ms: performance.now() - started,
			detail: error instanceof Error ? error.message.slice(0, 160) : "error",
		};
	}
}

async function probeChat(
	model: CandidateModel,
	apiKey: string,
	task: "extract" | "expand" | "summary",
): Promise<Omit<Cell, "task">> {
	const started = performance.now();
	const spec =
		task === "extract"
			? {
					maxTokens: 400,
					messages: [
						{
							role: "system",
							content:
								'Return JSON only: {"entities":[{"name":"","type":"Person|Organization|Concept|Location|Topic","confidence":0.9}]}',
						},
						{ role: "user", content: EXTRACT_USER },
					],
					ok: (parsed: unknown) => {
						if (!parsed || typeof parsed !== "object") return false;
						const entities = (parsed as { entities?: unknown }).entities;
						if (!Array.isArray(entities)) return false;
						const blob = JSON.stringify(entities).toLowerCase();
						return (
							blob.includes("alice") &&
							(blob.includes("acme") || blob.includes("berlin"))
						);
					},
				}
			: task === "expand"
				? {
						maxTokens: 256,
						messages: [
							{
								role: "system",
								content:
									"Return JSON only with arrays named translations, synonyms, concepts, and namedEntities.",
							},
							{ role: "user", content: EXPAND_USER },
						],
						ok: (parsed: unknown) => {
							if (!parsed || typeof parsed !== "object") return false;
							const translations = (parsed as { translations?: unknown })
								.translations;
							if (!Array.isArray(translations)) return false;
							return translations.some(
								(value) =>
									typeof value === "string" &&
									value.toLowerCase().includes("english"),
							);
						},
					}
				: {
						maxTokens: 256,
						messages: [
							{
								role: "system",
								content:
									"Return JSON only with language, description, and keywords.",
							},
							{ role: "user", content: SUMMARY_USER },
						],
						ok: (parsed: unknown) => {
							if (!parsed || typeof parsed !== "object") return false;
							const row = parsed as {
								language?: unknown;
								description?: unknown;
								keywords?: unknown;
							};
							return (
								typeof row.language === "string" &&
								row.language.trim().length > 0 &&
								typeof row.description === "string" &&
								row.description.trim().length > 8 &&
								Array.isArray(row.keywords)
							);
						},
					};
	try {
		const { status, json } = await requestJson(
			`${OPENROUTER_PUBLIC_BASE_URL}/chat/completions`,
			apiKey,
			chatBody(model, spec.messages, spec.maxTokens),
			25_000,
		);
		const choices = json.choices as
			| Array<{ message?: { content?: unknown } }>
			| undefined;
		const content = choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) {
			return {
				ok: false,
				ms: performance.now() - started,
				detail: errorDetail(json, status),
			};
		}
		let parsed: unknown;
		try {
			parsed = parseJson(content);
		} catch {
			return {
				ok: false,
				ms: performance.now() - started,
				detail: "malformed-json",
			};
		}
		const ok = status === 200 && spec.ok(parsed);
		return {
			ok,
			ms: performance.now() - started,
			detail: ok ? "json-ok" : "json-wrong",
		};
	} catch (error) {
		return {
			ok: false,
			ms: performance.now() - started,
			detail: error instanceof Error ? error.message.slice(0, 160) : "error",
		};
	}
}

async function probeRerank(
	model: CandidateModel,
	apiKey: string,
): Promise<Omit<Cell, "task">> {
	const started = performance.now();
	try {
		const { status, json } = await requestJson(
			OPENROUTER_RERANK_URL,
			apiKey,
			{
				model: model.id,
				query: "английский язык",
				documents: RERANK_DOCS,
				top_n: 5,
			},
			20_000,
		);
		const results = json.results as
			| Array<{ index: number; relevance_score: number }>
			| undefined;
		if (!results?.length) {
			return {
				ok: false,
				ms: performance.now() - started,
				detail: errorDetail(json, status),
			};
		}
		const top = results[0];
		const english = results.find((row) => row.index === 0);
		const bread = results.find((row) => row.index === 7);
		const rankedEnglishFirst = top?.index === 0;
		const englishAboveBread =
			english !== undefined &&
			(bread === undefined || english.relevance_score >= bread.relevance_score);
		const ok = status === 200 && rankedEnglishFirst && englishAboveBread;
		return {
			ok,
			ms: performance.now() - started,
			detail: ok ? `top=${top?.index}` : `top=${top?.index ?? "none"}`,
		};
	} catch (error) {
		return {
			ok: false,
			ms: performance.now() - started,
			detail: error instanceof Error ? error.message.slice(0, 160) : "error",
		};
	}
}

async function runCell(
	model: CandidateModel,
	task: Task,
	apiKey: string,
): Promise<Cell> {
	const applicable = tasksFor(model);
	if (!applicable.includes(task)) {
		return { task, ok: null, ms: null, detail: "n/a" };
	}
	const result =
		task === "embed"
			? await probeEmbed(model, apiKey)
			: task === "rerank"
				? await probeRerank(model, apiKey)
				: await probeChat(model, apiKey, task);
	return { task, ...result };
}

function fmt(cell: Cell): string {
	if (cell.ok === null) return "—";
	const ms = cell.ms === null ? "?" : `${Math.round(cell.ms)}ms`;
	return cell.ok ? `${ms} ✓` : `${ms} ✗ ${cell.detail}`;
}

async function main(): Promise<void> {
	const apiKey = liveKey();
	const queue: Array<() => Promise<void>> = [];
	const rows: Array<{
		id: string;
		role: string;
		slot: string;
		cells: Cell[];
	}> = [];

	for (const model of CANDIDATE_MODELS) {
		const cells: Cell[] = [];
		rows.push({
			id: model.id,
			role: model.role,
			slot: model.slot,
			cells,
		});
		for (const task of TASKS) {
			queue.push(async () => {
				const cell = await runCell(model, task, apiKey);
				cells.push(cell);
				console.log(`${model.id} ${task} ${fmt(cell)}`);
			});
		}
	}

	const workers = 3;
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < queue.length) {
			const index = cursor++;
			const job = queue[index];
			if (job) await job();
		}
	}
	await Promise.all(Array.from({ length: workers }, () => worker()));

	const header = [
		"Model",
		"Role",
		"Embed",
		"Extract",
		"Expand",
		"Summary",
		"Rerank",
	];
	const table = [
		header.join(" | "),
		header.map(() => "---").join(" | "),
		...rows.map((row) => {
			const byTask = Object.fromEntries(
				row.cells.map((cell) => [cell.task, cell]),
			) as Record<Task, Cell>;
			return [
				row.id,
				row.role,
				...TASKS.map((task) =>
					fmt(byTask[task] ?? { task, ok: null, ms: null, detail: "missing" }),
				),
			].join(" | ");
		}),
	].join("\n");

	const outDir = new URL("../../../scratch/", import.meta.url);
	await mkdir(outDir, { recursive: true });
	const outFile = new URL("openrouter-matrix-results.md", outDir);
	await Bun.write(outFile, `${table}\n`);
	console.log("\n=== MATRIX ===\n");
	console.log(table);
	console.log(`\nwrote ${outFile.pathname}`);
}

await main();
