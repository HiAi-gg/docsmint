export type PipelineProviderErrorCode =
	| "provider_failure"
	| "provider_timeout"
	| "invalid_provider_response"
	| "permanent_validation_failure"
	| "provider_unavailable";

export class PipelineProviderError extends Error {
	constructor(
		public readonly code: PipelineProviderErrorCode,
		public readonly retryable: boolean,
		message: string = code,
	) {
		super(message);
		this.name = "PipelineProviderError";
	}
}

export function pipelineErrorCode(error: unknown, fallback: string): string {
	if (error instanceof PipelineProviderError) return error.code;
	return fallback;
}

export function isRetryablePipelineError(code: string): boolean {
	return new Set([
		"provider_failure",
		"provider_timeout",
		"invalid_provider_response",
		"queue_enqueue_failed",
		"age_unavailable",
		"age_persist_failed",
	]).has(code);
}
