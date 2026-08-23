import { describe, expect, it } from "bun:test";
import {
	createGraphWorker,
	type PipelineStageStatus,
} from "../queue/workers/graph.worker";

const job = {
	schemaVersion: 2 as const,
	refreshMode: "full" as const,
	stage: "graph" as const,
	documentId: "00000000-0000-4000-8000-000000000001",
	ownerId: "00000000-0000-4000-8000-000000000002",
	generationId: "00000000-0000-4000-8000-000000000003",
	revision: "rev-1",
	requestedAt: "2026-07-12T00:00:00.000Z",
	source: "interactive" as const,
};

function deps(
	overrides: Partial<Parameters<typeof createGraphWorker>[0]> = {},
) {
	const statuses: string[] = [];
	return {
		statuses,
		getRun: async () => ({ ...job, embedStatus: "ready" as const }),
		extract: async () => ({ status: "ready" as const }),
		setGraphStatus: async (_id: string, status: PipelineStageStatus) => {
			statuses.push(status);
		},
		cancelStaleRun: async () => undefined,
		enqueueSummarize: async () => undefined,
		...overrides,
	};
}

describe("graph worker isolation", () => {
	it("records an unavailable graph dependency as an optional warning", async () => {
		const effects: string[] = [];
		const state = deps({
			extract: async () => ({
				status: "unavailable" as const,
				warning: "age_unavailable",
				entities: [],
			}),
			setGraphStatus: async (_id, status, errorCode) => {
				effects.push(`${status}:${errorCode ?? ""}`);
			},
			enqueueSummarize: async () => {
				effects.push("summarize");
			},
		});
		await createGraphWorker(state)(job);
		expect(effects).toEqual([
			"processing:",
			"failed:age_unavailable",
			"summarize",
		]);
	});

	it("records a provider failure as an optional graph warning", async () => {
		const effects: string[] = [];
		const state = deps({
			extract: async () => ({
				status: "failed" as const,
				warning: "provider_failed",
				entities: [],
			}),
			setGraphStatus: async (_id, status, errorCode) => {
				effects.push(`${status}:${errorCode ?? ""}`);
			},
			enqueueSummarize: async () => {
				effects.push("summarize");
			},
		});
		await createGraphWorker(state)(job);
		expect(effects).toEqual([
			"processing:",
			"failed:provider_failed",
			"summarize",
		]);
	});

	it("cancels a typed stale extraction outcome", async () => {
		const effects: string[] = [];
		const state = deps({
			extract: async () => ({
				status: "stale" as const,
				warning: "stale_revision",
			}),
			setGraphStatus: async (_id, status, errorCode) => {
				effects.push(`${status}:${errorCode ?? ""}`);
			},
			cancelStaleRun: async () => {
				effects.push("cancel-run");
			},
		});
		await createGraphWorker(state)(job);
		expect(effects).toEqual([
			"processing:",
			"cancelled:stale_revision",
			"cancel-run",
		]);
	});

	it("cancellation after extraction prevents ready status and downstream enqueue", async () => {
		const effects: string[] = [];
		let checks = 0;
		const worker = createGraphWorker({
			isCancelled: async () => ++checks >= 4,
			getRun: async () => ({
				ownerId: job.ownerId,
				documentId: job.documentId,
				generationId: job.generationId,
				revision: job.revision,
				embedStatus: "ready",
			}),
			extract: async () => {
				effects.push("extract");
				return { status: "ready" as const };
			},
			compensateExtract: async () => {
				effects.push("compensate");
			},
			setGraphStatus: async (_id, status) => {
				effects.push(status);
			},
			cancelStaleRun: async () => undefined,
			enqueueSummarize: async () => {
				effects.push("enqueue");
			},
		});
		await worker(job);
		expect(effects).toEqual(["processing", "extract", "compensate"]);
	});

	it("propagates graph compensation failure without writing success", async () => {
		let checks = 0;
		const worker = createGraphWorker({
			isCancelled: async () => ++checks >= 4,
			getRun: async () => ({ ...job, embedStatus: "ready" }),
			extract: async () => ({ status: "ready" as const }),
			compensateExtract: async () => {
				throw new Error("graph cleanup failed");
			},
			setGraphStatus: async () => {},
			cancelStaleRun: async () => undefined,
			enqueueSummarize: async () => {},
		});
		await expect(worker(job)).rejects.toThrow("graph cleanup failed");
	});
	it("does not change ready embeddings when graph extraction fails", async () => {
		let summaryEnqueues = 0;
		const state = deps({
			extract: async () => {
				throw new Error("provider timeout");
			},
			enqueueSummarize: async () => {
				summaryEnqueues += 1;
			},
		});
		const worker = createGraphWorker(state);
		await expect(worker(job)).rejects.toThrow("provider timeout");
		expect(state.statuses).toEqual(["processing", "failed"]);
		expect(summaryEnqueues).toBe(1);
		// The state lookup still reports embedStatus=ready: graph failure never
		// mutates document embedding readiness.
		expect((await state.getRun(job))?.embedStatus).toBe("ready");
	});

	it("terminally cancels a generation that loses the persistence fence", async () => {
		const effects: string[] = [];
		const stale = new Error("graph generation is stale");
		stale.name = "stale_revision";
		const state = deps({
			extract: async () => {
				throw stale;
			},
			setGraphStatus: async (_id, status) => {
				effects.push(status);
			},
			cancelStaleRun: async () => {
				effects.push("cancel-run");
			},
			enqueueSummarize: async () => {
				effects.push("summarize");
			},
		});
		await createGraphWorker(state)(job);
		expect(effects).toEqual(["processing", "cancelled", "cancel-run"]);
	});

	it("enqueues summarize again safely when a retry sees the same graph error", async () => {
		let summaryEnqueues = 0;
		const state = deps({
			extract: async () => {
				throw new Error("provider timeout");
			},
			enqueueSummarize: async () => {
				summaryEnqueues += 1;
			},
		});
		const worker = createGraphWorker(state);
		await expect(worker(job)).rejects.toThrow("provider timeout");
		await expect(worker(job)).rejects.toThrow("provider timeout");
		expect(summaryEnqueues).toBe(2);
	});

	it("skips graph work for a stale generation", async () => {
		const state = deps({
			getRun: async () => ({
				...job,
				embedStatus: "ready" as const,
				revision: "old",
			}),
		});
		await createGraphWorker(state)(job);
		expect(state.statuses).toEqual(["cancelled"]);
	});

	it("cancels graph work when the activated embedding context changed", async () => {
		const effects: string[] = [];
		const contextJob = {
			...job,
			schemaVersion: 2 as const,
			refreshMode: "incremental" as const,
			embeddingContextHash: "context-old",
		};
		const state = deps({
			getRun: async () => ({
				...contextJob,
				embedStatus: "ready" as const,
				embeddingContextHash: "context-new",
			}),
			extract: async () => {
				throw new Error("stale context must not extract");
			},
			setGraphStatus: async (_id, status, errorCode) => {
				effects.push(`${status}:${errorCode ?? ""}`);
			},
			cancelStaleRun: async () => {
				effects.push("cancel-run");
			},
		});
		await createGraphWorker(state)(contextJob);
		expect(effects).toEqual(["cancelled:stale_context", "cancel-run"]);
	});

	it("advances to summarize when embeddings are intentionally skipped", async () => {
		let summaryEnqueues = 0;
		const state = deps({
			getRun: async () => ({ ...job, embedStatus: "skipped" as const }),
			enqueueSummarize: async () => {
				summaryEnqueues += 1;
			},
		});
		await createGraphWorker(state)(job);
		expect(state.statuses).toEqual(["skipped"]);
		expect(summaryEnqueues).toBe(1);
	});
});
