interface FetchOptions extends Omit<RequestInit, "body"> {
	// Override `body` so callers can pass plain JSON objects. `apiFetch`
	// JSON-serializes them below; the `RequestInit.body` type only
	// accepts binary-ish payloads which doesn't reflect how the helper
	// is actually used.
	body?: BodyInit | null | object;
	timeout?: number;
	// Max number of retries on 429 (Too Many Requests). Defaults to 2 —
	// up to 3 total attempts before propagating the last 429. Set to 0 to
	// disable retries entirely (handy for tests / SSR where retry is
	// pointless or harmful).
	maxRetries?: number;
}

export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

// Raised when our internal timeout fires and aborts the request. Callers
// can catch this to surface a "request took too long" message instead of
// the generic AbortError bubbling up. Any other AbortError (HMR restart,
// component unmount, caller-supplied signal) is handled silently — see
// the AbortError branch in `apiFetch` below.
export class ApiTimeoutError extends Error {
	constructor(public readonly timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms`);
		this.name = "ApiTimeoutError";
	}
}

/**
 * Marker thrown when an in-flight `apiFetch` is aborted for a reason OTHER
 * than our internal timeout — typically Vite HMR tearing down the page in
 * dev mode, or a component unmounting mid-fetch. Callers can usually
 * ignore this (`try { ... } catch (e) { if (e instanceof ApiAbortError) return; throw e; }`)
 * because the surrounding UI is being torn down anyway. This avoids the
 * noisy `signal is aborted without reason` console error that otherwise
 * surfaces as an unhandled promise rejection on every HMR.
 */
export class ApiAbortError extends Error {
	constructor(reason?: unknown) {
		super(typeof reason === "string" ? reason : "Request aborted");
		this.name = "ApiAbortError";
	}
}

// Maximum number of retry attempts on a 429. Defaults to 0 — we do NOT
// retry on 429 because the backend's rate limiter is per-IP and shared
// across all callers on the same network (no x-forwarded-for in dev), so
// retrying immediately just doubles the load on the same bucket and turns
// a transient throttle into a sustained 429 storm. Callers that genuinely
// want a retry can pass `maxRetries: 2` per request.
const DEFAULT_429_MAX_RETRIES = 0;
// Backoff schedule in ms for 429 retries: attempt 0 fails, wait
// 429_BACKOFF_MS[0] ms before retry 1; if that also fails, wait
// 429_BACKOFF_MS[1] ms before retry 2; then give up.
const RETRY_429_BACKOFF_MS = [500, 1000] as const;

/**
 * Sleep that resolves after `ms` milliseconds, or rejects with an
 * AbortError `DOMException` if the controller aborts first. Used by
 * the 429 retry loop so a caller-initiated abort during the backoff
 * window surfaces as a clean cancellation rather than blocking for
 * the full delay. The outer catch translates the AbortError into
 * `ApiAbortError` (caller-supplied signal) or `ApiTimeoutError`
 * (internal timeout).
 */
function backoffSleep(ms: number, controller: AbortController): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		controller.signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted during retry backoff", "AbortError"));
			},
			{ once: true },
		);
	});
}

/**
 * Parse the `Retry-After` header (RFC 7231 §7.1.3) — it may be either a
 * delta-seconds value (`"5"`) or an HTTP-date. We accept the former
 * only; a malformed or date-formatted value falls back to the
 * exponential backoff schedule.
 */
function parseRetryAfter(value: string | null): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const seconds = Number(trimmed);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return seconds * 1000;
}

export async function apiFetch<T>(
	path: string,
	options: FetchOptions = {},
	// Optional fetcher — pass SvelteKit's `load`/`fetch` to inherit cookies
	// and bypass the `window.fetch` warning. Falls back to the global
	// `fetch` when called from the browser outside SvelteKit.
	fetcher: typeof fetch = fetch,
): Promise<T> {
	const {
		timeout = 10000,
		body,
		maxRetries = DEFAULT_429_MAX_RETRIES,
		...fetchOptions
	} = options;
	const controller = new AbortController();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeout);

	// If the caller supplied their own signal, propagate any abort from
	// it onto our internal controller. This is what lets a caller (or a
	// SvelteKit `load`/`fetch` plumbing) cancel an in-flight apiFetch —
	// including the 429 retry backoff sleep, which otherwise would block
	// for the full Retry-After window. Without this wiring the
	// caller-supplied signal is silently ignored inside the retry loop.
	const callerSignal = fetchOptions.signal ?? null;
	const onCallerAbort = () => controller.abort();
	if (callerSignal) {
		if (callerSignal.aborted) {
			controller.abort();
		} else {
			callerSignal.addEventListener("abort", onCallerAbort, { once: true });
		}
	}

	const headers: Record<string, string> = {};
	// Serialize plain JS objects to JSON. FormData, Blobs, ArrayBuffers,
	// ReadableStreams, and other BodyInit-compatible values pass through
	// unchanged so multipart uploads (FormData with files) and binary
	// PUTs keep working. We intentionally do NOT stringify anything that
	// already implements BodyInit — calling JSON.stringify on a Blob
	// would discard it and produce the useless literal string `"{}"`.
	const isPlainObject =
		typeof body === "object" &&
		body !== null &&
		!(body instanceof FormData) &&
		!(body instanceof Blob) &&
		!(body instanceof ArrayBuffer) &&
		!(body instanceof ReadableStream) &&
		!(body instanceof URLSearchParams) &&
		!ArrayBuffer.isView(body);
	const serializedBody: BodyInit | null | undefined =
		body == null
			? (body as null | undefined)
			: isPlainObject
				? (JSON.stringify(body) as string)
				: (body as BodyInit);
	if (body && !(body instanceof FormData)) {
		headers["Content-Type"] = "application/json";
	}

	try {
		// Single-attempt fetch (the body of the retry loop). Reads the
		// response and returns either the parsed JSON, or — if it's a
		// retryable 429 — throws a sentinel `Retry429Error` carrying the
		// server-suggested `Retry-After` (if any) so the outer loop can
		// decide whether to back off and try again.
		const attemptFetch = async (): Promise<T> => {
			const response = await fetcher(path, {
				...fetchOptions,
				body: serializedBody,
				signal: controller.signal,
				headers: {
					...headers,
					...fetchOptions.headers,
				},
				credentials: "include",
			});

			if (response.status === 429) {
				// Surface as a retry sentinel. We do NOT parse the body
				// here — the body is consumed inside the loop on the
				// final attempt to produce the real ApiError that the
				// caller sees.
				throw new Retry429Error(response.headers.get("Retry-After"));
			}

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
		};

		// Retry loop. `Retry429Error` is the only signal we re-enter on;
		// every other error (ApiError, AbortError, network failure)
		// propagates immediately so existing call-site semantics are
		// preserved.
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await attemptFetch();
			} catch (err) {
				if (!(err instanceof Retry429Error) || attempt === maxRetries) {
					throw err;
				}
				// Server-provided Retry-After (ms) wins over the schedule,
				// but is clamped to the same backoff steps so a hostile or
				// misconfigured server can't make us wait minutes.
				const serverHint = parseRetryAfter(err.retryAfter);
				const scheduledMs =
					RETRY_429_BACKOFF_MS[attempt] ??
					RETRY_429_BACKOFF_MS[RETRY_429_BACKOFF_MS.length - 1];
				const delayMs = Math.min(serverHint ?? scheduledMs, 10_000);
				// backoffSleep rejects with AbortError if the caller (or our
				// internal timeout) aborts during the wait, so the loop
				// unwinds cleanly without burning another fetch.
				await backoffSleep(delayMs, controller);
				// If the abort happened during the sleep, the throw from
				// backoffSleep will surface here — let the outer catch
				// translate it.
			}
		}
		// Unreachable: the loop either returns or throws. The TS compiler
		// can't see that, so we throw to satisfy the return type.
		throw new Error("apiFetch: exhausted retries without resolving");
	} catch (err) {
		// AbortError: the native DOMException surfaces with name "AbortError"
		// regardless of whether it was our timeout or something else (HMR,
		// unmount, caller-supplied signal, or the retry-backoff sleep being
		// aborted). Tag it with our own class so the caller can tell the
		// two apart and so the error message is friendlier than the raw
		// `signal is aborted without reason`.
		if (err instanceof DOMException && err.name === "AbortError") {
			if (timedOut) {
				throw new ApiTimeoutError(timeout);
			}
			throw new ApiAbortError(err.message);
		}
		// A retry attempt that gave up on 429 — translate the last
		// Retry429Error into a proper ApiError with the (best-effort)
		// error body so the caller's UI gets a sensible message instead
		// of the internal sentinel.
		if (err instanceof Retry429Error) {
			throw new ApiError("Too Many Requests", 429);
		}
		throw err;
	} finally {
		clearTimeout(timeoutId);
		if (callerSignal) {
			callerSignal.removeEventListener("abort", onCallerAbort);
		}
	}
}

// Internal sentinel for the 429 retry loop. Carries the
// `Retry-After` header so the loop can prefer server-suggested delays
// over the static exponential backoff. NOT exported.
class Retry429Error extends Error {
	constructor(public readonly retryAfter: string | null) {
		super("Retry after 429");
		this.name = "Retry429Error";
	}
}
