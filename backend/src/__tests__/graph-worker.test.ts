import { describe, expect, it } from "bun:test";
import { createGraphWorker } from "../queue/workers/graph.worker";

const job = {
	schemaVersion: 1 as const,
	stage: "graph" as const,
	documentId: "00000000-0000-4000-8000-000000000001",
	ownerId: "00000000-0000-4000-8000-000000000002",
	generationId: "00000000-0000-4000-8000-000000000003",
	revision: "rev-1",
	requestedAt: "2026-07-12T00:00:00.000Z",
	source: "interactive" as const,
};

function deps(overrides: Partial<Parameters<typeof createGraphWorker>[0]> = {}) {
	const statuses: string[] = [];
	return {
		statuses,
		getRun: async () => ({ ...job, embedStatus: "ready" as const }),
		extract: async () => {},
		setGraphStatus: async (_id: string, status: any) => { statuses.push(status); },
		...overrides,
	};
}

describe("graph worker isolation", () => {
	it("does not change ready embeddings when graph extraction fails", async () => {
		const state = deps({ extract: async () => { throw new Error("provider timeout"); } });
		const worker = createGraphWorker(state);
		await expect(worker(job)).rejects.toThrow("provider timeout");
		expect(state.statuses).toEqual(["processing", "failed"]);
		// The state lookup still reports embedStatus=ready: graph failure never
		// mutates document embedding readiness.
		expect((await state.getRun(job))?.embedStatus).toBe("ready");
	});

	it("skips graph work for a stale generation", async () => {
		const state = deps({
			getRun: async () => ({ ...job, embedStatus: "ready" as const, revision: "old" }),
		});
		await createGraphWorker(state)(job);
		expect(state.statuses).toEqual(["cancelled"]);
	});
});
