export type PipelineProviderErrorCode =
	| "provider_failure"
	| "provider_timeout"
	| "invalid_provider_response"
	| "permanent_validation_failure";

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
	if (error instanceof Error && error.message.trim()) return error.message;
	return fallback;
}

export function isRetryablePipelineError(code: string): boolean {
	return code !== "permanent_validation_failure";
}
