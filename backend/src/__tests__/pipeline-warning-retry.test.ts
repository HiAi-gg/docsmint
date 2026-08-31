import { describe, expect, it } from "bun:test";
import { planWarningStageRetry } from "../queue/pipeline-warning-retry";

describe("warning-stage retry planning", () => {
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
