import { describe, expect, test } from "bun:test";
import { buildKnowledgeSummary } from "../lib/knowledge-summary";

describe("knowledge summary generation", () => {
	test("skips an empty document without calling the provider", async () => {
		let called = false;
		const result = await buildKnowledgeSummary(
			{ title: "Untitled", content: "  \n\t", revision: "rev-empty" },
			async () => {
				called = true;
				return null;
			},
		);
		expect(result).toEqual({ status: "skipped", reason: "empty_document" });
		expect(called).toBe(false);
	});

	test("normalizes provider output into a deterministic persisted contract", async () => {
		const result = await buildKnowledgeSummary(
			{ title: "Roadmap", content: "Milestones", revision: "rev-1" },
			async () => ({
				language: " en ",
				description: " Product roadmap. ",
				keywords: ["Roadmap", "milestones", "roadmap", ""],
				model: "summary-model",
			}),
		);
		expect(result).toEqual({
			status: "ready",
			language: "en",
			description: "Product roadmap.",
			keywords: ["Roadmap", "milestones"],
			model: "summary-model",
		});
	});

	test("surfaces provider failure for warning finalization", async () => {
		await expect(
			buildKnowledgeSummary(
				{ title: "Roadmap", content: "Milestones", revision: "rev-1" },
				async () => null,
			),
		).rejects.toThrow("summary_provider_failed");
	});
});
