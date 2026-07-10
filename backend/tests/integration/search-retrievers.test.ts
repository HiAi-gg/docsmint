import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	getState,
	OTHER_USER_ID,
	OWNER_ID,
	resetState,
	seedSearchDocument,
	setupHarness,
} from "./_harness";

let retrieveFastChannels: typeof import("../../src/search/retrievers").retrieveFastChannels;

beforeAll(async () => {
	await setupHarness();
	({ retrieveFastChannels } = await import("../../src/search/retrievers"));
});

beforeEach(() => {
	resetState();
	seedSearchDocument({ id: "owned-doc", ownerId: OWNER_ID, title: "English" });
	seedSearchDocument({
		id: "other-owner-doc",
		ownerId: OTHER_USER_ID,
		title: "English",
	});
});

describe("search retriever tenant boundary", () => {
	test("does not return an identically named document owned by another user", async () => {
		const state = getState();
		const results = await retrieveFastChannels(
			{ userId: OWNER_ID, role: "user" },
			{
				original: "English",
				normalized: "English",
				detectedLanguage: "en",
				translations: [],
				synonyms: [],
				concepts: [],
				namedEntities: [],
			},
			{
				execute: async (channel) => {
					if (channel !== "exact") return [];
					return [...state.documents.values()].map((document) => ({
						document_id: document.id,
						owner_id: document.ownerId,
						score: document.ownerId === OWNER_ID ? 1 : 0.99,
					}));
				},
				queryEmbedding: { ok: false, code: "not_configured" },
			},
		);

		expect(
			results
				.flatMap((result) => result.candidates)
				.map((candidate) => candidate.documentId),
		).not.toContain("other-owner-doc");
		expect(
			results
				.flatMap((result) => result.candidates)
				.map((candidate) => candidate.documentId),
		).toContain("owned-doc");
	});
});
