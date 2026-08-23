import { describe, expect, test } from "bun:test";
import {
	deriveFinalStatus,
	processGraphStageFailure,
	processSummaryStage,
} from "../queue/stage-policies";

const Policy = {
	deriveFinalStatus,
	processGraphStageFailure,
	processSummaryStage,
};

const job = {
	documentId: "doc-1",
	ownerId: "owner-1",
	generationId: "generation-1",
	revision: "revision-1",
};

const run = {
	...job,
	status: "processing" as const,
	embedStatus: "ready" as const,
	graphStatus: "ready" as const,
	summarizeStatus: "skipped" as const,
};

describe("summary retry and finalization policy", () => {
	test("cancels summary work when the activated embedding context changed", async () => {
		const effects: string[] = [];
		const contextJob = { ...job, embeddingContextHash: "context-old" };
		await Policy.processSummaryStage?.(contextJob, {
			isCancelled: async () => false,
			isCurrent: async () => true,
			getRun: async () => ({
				...run,
				embeddingContextHash: "context-new",
			}),
			enabled: () => true,
			summarize: async () => {
				effects.push("summarize");
				return "ready";
			},
			setSummaryStatus: async (_id, status, errorCode) => {
				effects.push(`${status}:${errorCode ?? ""}`);
			},
			cancelStaleRun: async () => {
				effects.push("cancel-run");
			},
			enqueueFinalize: async () => {
				effects.push("finalize");
			},
		});
		expect(effects).toEqual(["cancelled:stale_context", "cancel-run"]);
	});

	test("derives ready and warning final states without loading queue dependencies", () => {
		expect(typeof Policy.deriveFinalStatus).toBe("function");
		expect(Policy.deriveFinalStatus?.(run)).toBe("ready");
		expect(
			Policy.deriveFinalStatus?.({ ...run, summarizeStatus: "failed" }),
		).toBe("ready_with_warnings");
	});

	test("swallows a terminal optional-summary failure and finalizes once", async () => {
		expect(typeof Policy.processSummaryStage).toBe("function");
		const effects: string[] = [];
		await expect(
			Policy.processSummaryStage?.(job, {
				isCancelled: async () => false,
				isCurrent: async () => true,
				getRun: async () => run,
				enabled: () => true,
				summarize: async () => {
					throw new Error("summary_provider_failed");
				},
				setSummaryStatus: async (_id: string, status: string) => {
					effects.push(status);
				},
				enqueueFinalize: async () => {
					effects.push("finalize");
				},
			}),
		).resolves.toBeUndefined();
		expect(effects).toEqual(["processing", "failed", "finalize"]);
	});

	test("does not publish status or finalize after the generation fence is lost", async () => {
		const effects: string[] = [];
		let currentChecks = 0;
		await Policy.processSummaryStage?.(job, {
			isCancelled: async () => false,
			isCurrent: async () => ++currentChecks < 4,
			getRun: async () => run,
			enabled: () => true,
			summarize: async () => "ready",
			setSummaryStatus: async (_id: string, status: string) => {
				effects.push(status);
			},
			enqueueFinalize: async () => {
				effects.push("finalize");
			},
		});
		expect(effects).toEqual(["processing", "cancelled"]);
	});

	test("terminally cancels a run that is already stale before summary work", async () => {
		const effects: string[] = [];
		await Policy.processSummaryStage?.(job, {
			isCancelled: async () => false,
			isCurrent: async () => false,
			getRun: async () => run,
			enabled: () => true,
			summarize: async () => "ready",
			setSummaryStatus: async () => {
				effects.push("summary-status");
			},
			cancelStaleRun: async () => {
				effects.push("cancel-run");
			},
			enqueueFinalize: async () => {
				effects.push("finalize");
			},
		});
		expect(effects).toEqual(["cancel-run"]);
	});

	test("terminally cancels when the generation fence is lost after status publication", async () => {
		const effects: string[] = [];
		let currentChecks = 0;
		await Policy.processSummaryStage?.(job, {
			isCancelled: async () => false,
			isCurrent: async () => ++currentChecks < 5,
			getRun: async () => run,
			enabled: () => true,
			summarize: async () => "ready",
			setSummaryStatus: async (_id: string, status: string) => {
				effects.push(status);
			},
			cancelStaleRun: async () => {
				effects.push("cancel-run");
			},
			enqueueFinalize: async () => {
				effects.push("finalize");
			},
		});
		expect(effects).toEqual(["processing", "ready", "cancel-run"]);
	});

	test("preserves an explicit cancellation reason instead of classifying it as stale", async () => {
		const effects: string[] = [];
		await Policy.processSummaryStage?.(job, {
			isCancelled: async () => true,
			isCurrent: async () => {
				effects.push("current-check");
				return false;
			},
			getRun: async () => run,
			enabled: () => true,
			summarize: async () => "ready",
			setSummaryStatus: async () => {
				effects.push("summary-status");
			},
			cancelStaleRun: async () => {
				effects.push("cancel-run");
			},
			enqueueFinalize: async () => {
				effects.push("finalize");
			},
		});
		expect(effects).toEqual([]);
	});

	test("terminally cancels stale graph persistence without retrying", async () => {
		expect(typeof Policy.processGraphStageFailure).toBe("function");
		const effects: string[] = [];
		const error = new Error("graph generation is stale");
		error.name = "stale_revision";
		await expect(
			Policy.processGraphStageFailure?.(job, error, {
				isCancelled: async () => false,
				setGraphStatus: async (_id: string, status: string) => {
					effects.push(status);
				},
				cancelStaleRun: async () => {
					effects.push("cancel-run");
				},
				enqueueSummarize: async () => {
					effects.push("summarize");
				},
			}),
		).resolves.toBeUndefined();
		expect(effects).toEqual(["cancelled", "cancel-run"]);
	});
});
