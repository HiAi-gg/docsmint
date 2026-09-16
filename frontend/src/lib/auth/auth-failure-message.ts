export type AuthFailureLabels = {
	credentialError: string;
	networkError: string;
};

export type AuthClientFailure =
	| {
			message?: string;
			status?: number;
			statusCode?: number;
			statusText?: string;
			error?: string;
			code?: string;
	  }
	| null
	| undefined;

const PROXY_FAILURE = /failed to proxy request/i;

function numericStatus(error: AuthClientFailure): number | undefined {
	if (!error) return undefined;
	if (typeof error.status === "number") return error.status;
	if (typeof error.statusCode === "number") return error.statusCode;
	return undefined;
}

function rawMessage(error: AuthClientFailure): string | undefined {
	if (!error) return undefined;
	if (typeof error.message === "string" && error.message.trim()) {
		return error.message;
	}
	if (typeof error.error === "string" && error.error.trim()) {
		return error.error;
	}
	return undefined;
}

export function authFailureMessage(
	error: AuthClientFailure,
	labels: AuthFailureLabels,
): string {
	const status = numericStatus(error);
	const message = rawMessage(error);
	if (status !== undefined && status >= 500) return labels.networkError;
	if (message && PROXY_FAILURE.test(message)) return labels.networkError;
	if (message) return message;
	if (status !== undefined && status >= 400 && status < 500) {
		return labels.credentialError;
	}
	return labels.networkError;
}
