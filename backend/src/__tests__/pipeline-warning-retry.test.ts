import { describe, expect, it } from "bun:test";
import {
	planWarningStageRetry,
	resolveActiveWarningRetry,
	summaryJobIdForPipeline,
	warningRetryJobId,
} from "../queue/pipeline-warning-retry";

describe("warning-stage retry planning", () => {
	it("distinguishes a warning worker from an ordinary processing stage", () => {
		expect(resolveActiveWarningRetry(true, false)).toBe("conflict");
		expect(resolveActiveWarningRetry(true, true)).toBe("deduplicate");
		expect(resolveActiveWarningRetry(false, false)).toBe("enqueue");
	});

	it("never re-enqueues a started retry when its retained job turns terminal", () => {
		// The decision intentionally depends on identity, not a racy BullMQ state
		// snapshot: a job that finishes between lookup and response remains a no-op.
		expect(resolveActiveWarningRetry(true, true)).toBe("deduplicate");
	});

	it("keeps the same warning identity when a graph retry advances to summary", () => {
		expect(warningRetryJobId("graph", "generation-a")).toBe(
			"graph-warning-retry-generation-a",
		);
		expect(warningRetryJobId("summarize", "generation-a")).toBe(
			"summarize-warning-retry-generation-a",
		);
		expect(
			summaryJobIdForPipeline({
				generationId: "generation-a",
				warningRetry: true,
			}),
		).toBe("summarize-warning-retry-generation-a");
		expect(
			summaryJobIdForPipeline({
				generationId: "generation-a",
				workspaceId: "workspace-a",
			}),
		).toBe("summary-generation-a-workspace-a");
	});
	it("retries graph only without selecting an already-ready summary", () => {
		expect(
			planWarningStageRetry({
				graphStatus: "failed",
				summarizeStatus: "ready",
				graphErrorCode: "provider_timeout",
				summarizeErrorCode: null,
			}),
		).toEqual({ graph: true, summarize: false, entryStage: "graph" });
	});

	it("starts at graph when both optional stages failed", () => {
		expect(
			planWarningStageRetry({
				graphStatus: "failed",
				summarizeStatus: "failed",
				graphErrorCode: "provider_failure",
				summarizeErrorCode: "invalid_provider_response",
			}),
		).toEqual({ graph: true, summarize: true, entryStage: "graph" });
	});

	it("does not retry permanent validation failures or claimed stages", () => {
		expect(
			planWarningStageRetry({
				graphStatus: "failed",
				summarizeStatus: "ready",
				graphErrorCode: "permanent_validation_failure",
				summarizeErrorCode: null,
			}),
		).toBeNull();
		expect(
			planWarningStageRetry({
				graphStatus: "retrying",
				summarizeStatus: "ready",
				graphErrorCode: null,
				summarizeErrorCode: null,
			}),
		).toBeNull();
	});
});
