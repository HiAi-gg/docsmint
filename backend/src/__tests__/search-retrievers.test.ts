import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { EmbeddingResult } from "../embedding/result";
import { retrieveFastChannels } from "../search/retrievers";
import type { QueryPlan, SearchChannel } from "../search/types";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000000002";

const plan: QueryPlan = {
	original: "английский",
	normalized: "английский",
	detectedLanguage: "ru",
	translations: [],
	synonyms: [],
	concepts: [],
	namedEntities: [],
};

const embedding: EmbeddingResult = {
	ok: true,
	vector: Array.from({ length: 1024 }, () => 0.01),
	model: "openai/text-embedding-3-small",
	provider: "primary",
	dimensions: 1024,
	profile: "openai/text-embedding-3-small:1024:v1",
};

type FakeRow = Record<string, unknown>;

function executor(rowsByChannel: Partial<Record<SearchChannel, FakeRow[]>>) {
	return async (channel: SearchChannel) => rowsByChannel[channel] ?? [];
}

describe("owner-scoped retrieval channels", () => {
	test("filters near-zero stored vectors with the shared norm epsilon", async () => {
		let vectorQuery: unknown;
		await retrieveFastChannels({ userId: OWNER_ID, role: "user" }, plan, {
			execute: async (channel, _ctx, query) => {
				if (channel === "vector") vectorQuery = query;
				return [];
			},
			queryEmbedding: embedding,
		});

		expect(vectorQuery).toBeDefined();
		const rendered = new PgDialect().sqlToQuery(
			vectorQuery as Parameters<PgDialect["sqlToQuery"]>[0],
		);
		expect(rendered.sql).toContain("vector_norm(de.embedding) >");
		expect(rendered.params).toContain(1e-9);
	});

	test("allows internal retrieval windows larger than the public page size", async () => {
		const limits: number[] = [];
		await retrieveFastChannels({ userId: OWNER_ID, role: "user" }, plan, {
			limit: 500,
			execute: async (_channel, _ctx, query) => {
				const rendered = new PgDialect().sqlToQuery(
					query as Parameters<PgDialect["sqlToQuery"]>[0],
				);
				const limit = rendered.params.at(-1);
				if (typeof limit === "number") limits.push(limit);
				return [];
			},
			queryEmbedding: embedding,
		});

		expect(limits).toEqual([500, 500, 500, 500]);
	});

	test("returns exact, multilingual FTS, and fuzzy candidates with ranks", async () => {
		const results = await retrieveFastChannels(
			{ userId: OWNER_ID, role: "user" },
			plan,
			{
				execute: executor({
					exact: [{ document_id: "exact-doc", owner_id: OWNER_ID, score: 1 }],
					fts: [{ document_id: "fts-doc", owner_id: OWNER_ID, score: 0.8 }],
					fuzzy: [{ document_id: "fuzzy-doc", owner_id: OWNER_ID, score: 0.4 }],
				}),
				queryEmbedding: { ok: false, code: "not_configured" },
			},
		);

		expect(results.map((result) => result.channel)).toEqual([
			"exact",
			"fts",
			"fuzzy",
			"vector",
		]);
		expect(results.flatMap((result) => result.candidates)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ documentId: "exact-doc", rank: 1 }),
				expect.objectContaining({ documentId: "fts-doc", rank: 1 }),
				expect.objectContaining({ documentId: "fuzzy-doc", rank: 1 }),
			]),
		);
		expect(
			results.find((result) => result.channel === "vector")?.errorCode,
		).toBe("not_configured");
	});

	test("filters another owner's identically named document at the adapter boundary", async () => {
		const otherOwnerDocumentId = "other-owner-doc";
		const results = await retrieveFastChannels(
			{ userId: OWNER_ID, role: "user" },
			{ ...plan, normalized: "English" },
			{
				execute: executor({
					exact: [
						{ document_id: "owned-doc", owner_id: OWNER_ID, score: 1 },
						{
							document_id: otherOwnerDocumentId,
							owner_id: OTHER_OWNER_ID,
							score: 1,
						},
					],
				}),
				queryEmbedding: { ok: false, code: "not_configured" },
			},
		);

		expect(
			results
				.flatMap((result) => result.candidates)
				.map((candidate) => candidate.documentId),
		).not.toContain(otherOwnerDocumentId);
	});

	test("keeps only active, valid, profile-compatible vectors above the threshold", async () => {
		const results = await retrieveFastChannels(
			{ userId: OWNER_ID, role: "user" },
			plan,
			{
				execute: executor({
					vector: [
						{
							document_id: "active-doc",
							owner_id: OWNER_ID,
							score: 0.91,
						},
						{
							document_id: "weak-doc",
							owner_id: OWNER_ID,
							score: 0.1,
						},
						{
							document_id: "zero-doc",
							owner_id: OWNER_ID,
							score: Number.NaN,
						},
						{
							document_id: "inactive-doc",
							owner_id: OWNER_ID,
							score: 0.95,
							is_active: false,
						},
						{
							document_id: "mismatched-profile-doc",
							owner_id: OWNER_ID,
							score: 0.95,
							profile_compatible: false,
						},
					],
				}),
				queryEmbedding: embedding,
				vectorMinSimilarity: 0.35,
			},
		);

		expect(
			results.find((result) => result.channel === "vector")?.candidates,
		).toEqual([
			expect.objectContaining({ documentId: "active-doc", rawScore: 0.91 }),
		]);
	});

	test("returns vector provider failures without failing lexical channels", async () => {
		const results = await retrieveFastChannels(
			{ userId: OWNER_ID, role: "user" },
			plan,
			{
				execute: executor({
					fts: [{ document_id: "lexical-doc", owner_id: OWNER_ID, score: 0.5 }],
				}),
				queryEmbedding: { ok: false, code: "provider_error" },
			},
		);

		expect(
			results.find((result) => result.channel === "fts")?.candidates,
		).toHaveLength(1);
		expect(
			results.find((result) => result.channel === "vector")?.errorCode,
		).toBe("provider_error");
	});
});
