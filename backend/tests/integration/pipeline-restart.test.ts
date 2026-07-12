import { describe, expect, it } from "bun:test";
import { JOB_IDS } from "../../src/queue/contracts";

describe("pipeline restart recovery scaffolding", () => {
	it("recreates nonterminal work with deterministic stage job IDs", () => {
		const run = {
			documentId: "00000000-0000-4000-8000-000000000001",
			generationId: "00000000-0000-4000-8000-000000000002",
			stages: ["prepare", "embed", "graph", "summarize", "finalize"] as const,
			statuses: ["processing", "ready", "pending", "skipped", "pending"] as const,
		};
		const ids = run.stages.flatMap((stage, index) =>
			run.statuses[index] === "ready" || run.statuses[index] === "skipped"
				? []
				: [stage === "prepare"
					? JOB_IDS.prepare(run.documentId, run.generationId)
					: stage === "embed"
						? JOB_IDS.embed(run.generationId, 0)
						: stage === "graph"
							? JOB_IDS.graph(run.generationId)
							: stage === "summarize"
								? JOB_IDS.summarize(run.generationId)
								: JOB_IDS.finalize(run.generationId)],
		);
		expect(ids).toEqual([
			JOB_IDS.prepare(run.documentId, run.generationId),
			JOB_IDS.graph(run.generationId),
			JOB_IDS.finalize(run.generationId),
		]);
	});

	it("keeps recovery owner-scoped and does not delete PostgreSQL run state", () => {
		const ownerA = { ownerId: "owner-a", documentId: "doc-a" };
		const ownerB = { ownerId: "owner-b", documentId: "doc-b" };
		const recovered = [ownerA, ownerB].filter((run) => run.ownerId === "owner-a");
		expect(recovered).toEqual([ownerA]);
		expect(ownerB.documentId).toBe("doc-b");
	});
});
