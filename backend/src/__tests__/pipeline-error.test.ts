import { describe, expect, it } from "bun:test";
import {
	isRetryablePipelineError,
	PipelineProviderError,
	pipelineErrorCode,
} from "../lib/pipeline-error";

describe("pipeline provider diagnostics", () => {
	it("keeps timeout, provider, response, and validation failures distinct", () => {
		for (const code of [
			"provider_timeout",
			"provider_failure",
			"invalid_provider_response",
			"permanent_validation_failure",
		] as const) {
			expect(
				pipelineErrorCode(new PipelineProviderError(code, true), "x"),
			).toBe(code);
		}
	});

	it("marks permanent validation failures as non-retryable", () => {
		expect(isRetryablePipelineError("provider_timeout")).toBe(true);
		expect(isRetryablePipelineError("permanent_validation_failure")).toBe(
			false,
		);
	});
});
