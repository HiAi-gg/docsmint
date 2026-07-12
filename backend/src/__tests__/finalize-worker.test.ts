import { describe, expect, it } from "bun:test";
import { deriveFinalStatus } from "../queue/workers/finalize.worker";
import { createSummarizeWorker } from "../queue/workers/summarize.worker";

const job = {
	schemaVersion: 1 as const,
	stage: "finalize" as const,
	documentId: "00000000-0000-4000-8000-000000000001",
	ownerId: "00000000-0000-4000-8000-000000000002",
	generationId: "00000000-0000-4000-8000-000000000003",
	revision: "rev-1",
	requestedAt: "2026-07-12T00:00:00.000Z",
	source: "interactive" as const,
};

const baseRun = {
	...job,
	status: "processing" as const,
	embedStatus: "ready" as const,
	graphStatus: "ready" as const,
	summarizeStatus: "skipped" as const,
};

describe("finalize worker semantics", () => {
	it("returns ready when graph and summary are ready or skipped", () => {
		expect(deriveFinalStatus(baseRun)).toBe("ready");
	});

	it("returns ready_with_warnings for graph failure without losing embeddings", () => {
		expect(deriveFinalStatus({ ...baseRun, graphStatus: "failed" })).toBe(
			"ready_with_warnings",
		);
	});

	it("fails the run when embedding failed", () => {
		expect(deriveFinalStatus({ ...baseRun, embedStatus: "failed" })).toBe(
			"failed",
		);
	});

	it("skips optional summary and enqueues finalize", async () => {
		const statuses: string[] = [];
		let enqueued = false;
		const worker = createSummarizeWorker({
			getRun: async () => ({ ...baseRun }),
			enabled: () => false,
			summarize: async () => {},
			setSummaryStatus: async (_id, status) => {
				statuses.push(status);
			},
			enqueueFinalize: async () => {
				enqueued = true;
			},
		});
		await worker({ ...job, stage: "summarize" });
		expect(statuses).toEqual(["skipped"]);
		expect(enqueued).toBe(true);
	});
});
