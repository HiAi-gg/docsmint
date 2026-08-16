import { describe, expect, it } from "bun:test";
import {
	deriveFinalStatus,
	processSummaryStage,
} from "../queue/stage-policies";

const job = {
	documentId: "00000000-0000-4000-8000-000000000001",
	ownerId: "00000000-0000-4000-8000-000000000002",
	generationId: "00000000-0000-4000-8000-000000000003",
	revision: "rev-1",
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
		await processSummaryStage(job, {
			getRun: async () => ({ ...baseRun }),
			enabled: () => false,
			summarize: async () => "ready",
			setSummaryStatus: async (_id, status) => {
				statuses.push(status);
			},
			enqueueFinalize: async () => {
				enqueued = true;
			},
		});
		expect(statuses).toEqual(["skipped"]);
		expect(enqueued).toBe(true);
	});

	it("does not persist or finalize when cancellation wins after summarize", async () => {
		const effects: string[] = [];
		let checks = 0;
		await processSummaryStage(job, {
			isCancelled: async () => ++checks >= 4,
			getRun: async () => ({ ...baseRun }),
			enabled: () => true,
			summarize: async () => {
				effects.push("summarize");
				return "ready";
			},
			setSummaryStatus: async (_id, status) => {
				effects.push(status);
			},
			enqueueFinalize: async () => {
				effects.push("finalize");
			},
		});
		expect(effects).toEqual(["processing", "summarize", "cancelled"]);
	});

	it("swallows terminal summary failure before warning finalization", async () => {
		const effects: string[] = [];
		await expect(
			processSummaryStage(job, {
				getRun: async () => ({ ...baseRun }),
				enabled: () => true,
				summarize: async () => {
					throw new Error("summary_provider_failed");
				},
				setSummaryStatus: async (_id, status) => {
					effects.push(status);
				},
				enqueueFinalize: async () => {
					effects.push("finalize");
				},
			}),
		).resolves.toBeUndefined();
		expect(effects).toEqual(["processing", "failed", "finalize"]);
	});
});
