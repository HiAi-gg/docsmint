interface FetchOptions extends RequestInit {
	timeout?: number;
}

export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

export async function apiFetch<T>(
	path: string,
	options: FetchOptions = {},
	// Optional fetcher — pass SvelteKit's `load`/`fetch` to inherit cookies
	// and bypass the `window.fetch` warning. Falls back to the global
	// `fetch` when called from the browser outside SvelteKit.
	fetcher: typeof fetch = fetch,
): Promise<T> {
	const { timeout = 10000, body, ...fetchOptions } = options;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	const headers: Record<string, string> = {};
	if (body && !(body instanceof FormData)) {
		headers["Content-Type"] = "application/json";
	}

	try {
		const response = await fetcher(path, {
			...fetchOptions,
			body,
			signal: controller.signal,
			headers: {
				...headers,
				...fetchOptions.headers,
			},
			credentials: "include",
		});

		if (!response.ok) {
			const error = await response
				.json()
				.catch(() => ({ error: response.statusText }));
			throw new ApiError(
				error.error ?? `HTTP ${response.status}`,
				response.status,
			);
		}

		return response.json() as Promise<T>;
	} finally {
		clearTimeout(timeoutId);
	}
}
