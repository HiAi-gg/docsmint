import { describe, expect, test } from "bun:test";
import * as KnowledgeSummary from "../lib/knowledge-summary";

const { buildKnowledgeSummary } = KnowledgeSummary;

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

describe("summary generation fence", () => {
	test("runs the provider outside transactions and refuses a stale persistence", async () => {
		const summaryDocument = {
			title: "Roadmap",
			content: "Milestones",
			revision: "rev-1",
		};
		const runKnowledgeSummaryStage = (
			KnowledgeSummary as typeof KnowledgeSummary & {
				runKnowledgeSummaryStage?: (dependencies: {
					readCurrent: () => Promise<typeof summaryDocument | null>;
					generate: (
						document: typeof summaryDocument,
					) => Promise<KnowledgeSummary.KnowledgeSummaryResult>;
					persistIfCurrent: (
						summary: KnowledgeSummary.KnowledgeSummaryProviderResult,
					) => Promise<boolean>;
				}) => Promise<"ready" | "skipped" | "cancelled">;
			}
		).runKnowledgeSummaryStage;
		expect(typeof runKnowledgeSummaryStage).toBe("function");
		let transactionOpen = false;
		let activeGeneration = "generation-1";
		let persisted = false;
		const result = await runKnowledgeSummaryStage?.({
			readCurrent: async () => {
				transactionOpen = true;
				try {
					return summaryDocument;
				} finally {
					transactionOpen = false;
				}
			},
			generate: async () => {
				expect(transactionOpen).toBe(false);
				activeGeneration = "generation-2";
				return {
					status: "ready",
					language: "en",
					description: "Description",
					keywords: ["keyword"],
					model: "summary-model",
				};
			},
			persistIfCurrent: async () => {
				transactionOpen = true;
				try {
					if (activeGeneration !== "generation-1") return false;
					persisted = true;
					return true;
				} finally {
					transactionOpen = false;
				}
			},
		});
		expect(result).toBe("cancelled");
		expect(persisted).toBe(false);
	});
});
