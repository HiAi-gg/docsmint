import { describe, expect, test } from "bun:test";
import { hasSearchableActiveGeneration } from "../embedding/searchable-generation";

describe("active embedding search eligibility", () => {
	test("keeps a valid active generation searchable while replacement is pending", () => {
		expect(
			hasSearchableActiveGeneration({
				activeGenerationId: "generation-a",
				candidateGenerationId: "generation-b",
				rowGenerationId: "generation-a",
				documentProfile: "model:1024:v1",
				rowProfile: "model:1024:v1",
				rowDimensions: 1024,
				rowValid: true,
			}),
		).toBe(true);
	});

	test("rejects the pending generation and invalid active rows", () => {
		const base = {
			activeGenerationId: "generation-a",
			candidateGenerationId: "generation-b",
			documentProfile: "model:1024:v1",
			rowProfile: "model:1024:v1",
			rowDimensions: 1024,
			rowValid: true,
		};
		expect(
			hasSearchableActiveGeneration({
				...base,
				rowGenerationId: "generation-b",
			}),
		).toBe(false);
		expect(
			hasSearchableActiveGeneration({
				...base,
				rowGenerationId: "generation-a",
				rowValid: false,
			}),
		).toBe(false);
	});
});
