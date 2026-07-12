import { beforeEach, describe, expect, test } from "bun:test";
import "./_harness.js";
import { getState, resetState } from "./_harness.js";

const { activateEmbeddingGeneration, canTransition } = await import(
	"../../src/embedding/generation"
);

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000101";
const ACTIVE_GENERATION = "00000000-0000-4000-8000-000000000201";
const CANDIDATE_GENERATION = "00000000-0000-4000-8000-000000000202";
const PROFILE = "openai/text-embedding-3-small:1024:v1";
const MODEL = "openai/text-embedding-3-small";

function seedDocument(): void {
	const state = getState();
	state.documents.set(DOCUMENT_ID, {
		id: DOCUMENT_ID,
		ownerId: "00000000-0000-4000-8000-000000000001",
		title: "Generation test",
		content: "content",
		activeEmbeddingGeneration: ACTIVE_GENERATION,
		pendingEmbeddingGeneration: CANDIDATE_GENERATION,
		embeddingStatus: "processing",
		embeddingProfile: PROFILE,
		embeddingErrorCode: null,
	});
	state.documentEmbeddings.push({
		documentId: DOCUMENT_ID,
		generationId: ACTIVE_GENERATION,
		chunkIndex: 0,
		chunkText: "active",
		chunkHash: "active-hash",
		embeddingModel: MODEL,
		embeddingProfile: PROFILE,
		embeddingDimensions: 1024,
		isValid: true,
	});
}

function addCandidateRow(chunkIndex: number, isValid = true): void {
	getState().documentEmbeddings.push({
		documentId: DOCUMENT_ID,
		generationId: CANDIDATE_GENERATION,
		chunkIndex,
		chunkText: `candidate-${chunkIndex}`,
		chunkHash: `candidate-hash-${chunkIndex}`,
		embeddingModel: MODEL,
		embeddingProfile: PROFILE,
		embeddingDimensions: 1024,
		isValid,
	});
}

describe("embedding generation transaction contract", () => {
	beforeEach(() => {
		resetState();
		seedDocument();
	});

	test("keeps active generation A when candidate B is invalid", async () => {
		addCandidateRow(0, true);
		addCandidateRow(1, false);

		await expect(
			activateEmbeddingGeneration(DOCUMENT_ID, CANDIDATE_GENERATION, 2, {
				model: MODEL,
				dimensions: 1024,
				profile: PROFILE,
			}),
		).rejects.toThrow("generation_invalid_profile");

		expect(
			getState().documents.get(DOCUMENT_ID)?.activeEmbeddingGeneration,
		).toBe(ACTIVE_GENERATION);
	});

	test("does not activate candidate B until every expected row is valid", async () => {
		addCandidateRow(0, true);

		await expect(
			activateEmbeddingGeneration(
				DOCUMENT_ID,
				CANDIDATE_GENERATION,
				2,
				PROFILE,
			),
		).rejects.toThrow("generation_incomplete");
		expect(
			getState().documents.get(DOCUMENT_ID)?.activeEmbeddingGeneration,
		).toBe(ACTIVE_GENERATION);
	});

	test("switches to candidate B only after the complete valid generation is staged", async () => {
		addCandidateRow(0, true);
		addCandidateRow(1, true);

		await activateEmbeddingGeneration(DOCUMENT_ID, CANDIDATE_GENERATION, 2, {
			model: MODEL,
			dimensions: 1024,
			profile: PROFILE,
		});

		const state = getState();
		expect(state.documents.get(DOCUMENT_ID)?.activeEmbeddingGeneration).toBe(
			CANDIDATE_GENERATION,
		);
		expect(state.documents.get(DOCUMENT_ID)?.pendingEmbeddingGeneration).toBe(
			null,
		);
		expect(
			state.documentEmbeddings.every(
				(row) => row.generationId === CANDIDATE_GENERATION,
			),
		).toBe(true);
	});

	test("keeps lifecycle transitions explicit", () => {
		expect(canTransition("pending", "processing")).toBe(true);
		expect(canTransition("processing", "ready")).toBe(true);
		expect(canTransition("processing", "failed")).toBe(true);
		expect(canTransition("ready", "stale")).toBe(true);
		expect(canTransition("failed", "ready")).toBe(false);
	});
});
