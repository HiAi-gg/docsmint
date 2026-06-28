import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, apiFetch } from "./client";

// Minimal fetch stub — records every call and lets each test script the
// 429 / success sequence without touching the network.
type FetchCall = {
	url: string;
	init: RequestInit;
};
let calls: FetchCall[] = [];
let script: ((call: FetchCall) => Response | Promise<Response>)[] = [];
let nextScriptIdx = 0;

function makeResponse(
	status: number,
	body?: unknown,
	headers?: HeadersInit,
): Response {
	return new Response(body !== undefined ? JSON.stringify(body) : null, {
		status,
		headers: {
			"content-type": "application/json",
			...headers,
		},
	});
}

function installFetchStub() {
	calls = [];
	script = [];
	nextScriptIdx = 0;
	(globalThis as unknown as { fetch: typeof fetch }).fetch = ((
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		const call: FetchCall = { url, init: init ?? {} };
		calls.push(call);
		const handler = script[nextScriptIdx++];
		if (!handler) {
			return Promise.resolve(makeResponse(500, { error: "no script" }));
		}
		return Promise.resolve(handler(call));
	}) as typeof fetch;
}

function uninstallFetchStub() {
	delete (globalThis as unknown as { fetch?: typeof fetch }).fetch;
}

afterEach(() => {
	uninstallFetchStub();
});

describe("apiFetch", () => {
	test("is a function", () => {
		expect(typeof apiFetch).toBe("function");
	});

	test("returns promise", () => {
		installFetchStub();
		script.push(() => makeResponse(200, { ok: true }));
		const result = apiFetch("/api/test");
		expect(result).toBeInstanceOf(Promise);
		// Don't await - will fail with network error in test env
		result.catch(() => {});
	});

	test("retries on 429 and resolves on a later success", async () => {
		installFetchStub();
		script.push(() => makeResponse(429, undefined, { "retry-after": "0" }));
		script.push(() => makeResponse(200, { ok: true }));

		const result = await apiFetch<{ ok: boolean }>(
			"/api/test",
			// Backoff schedule is 500ms then 1000ms — we keep retries on
			// but pass a fast maxRetries to avoid slowing the suite.
			{ maxRetries: 2 },
		);
		expect(result).toEqual({ ok: true });
		expect(calls.length).toBe(2);
	});

	test("stops retrying after maxRetries and throws ApiError(429)", async () => {
		installFetchStub();
		// Three 429s in a row: initial + 2 retries = maxRetries: 2. Backoff
		// is clamped to 10s but server says retry-after: 0, so each
		// iteration completes near-instantly.
		script.push(() => makeResponse(429, undefined, { "retry-after": "0" }));
		script.push(() => makeResponse(429, undefined, { "retry-after": "0" }));
		script.push(() => makeResponse(429, undefined, { "retry-after": "0" }));

		const err = await apiFetch("/api/test", { maxRetries: 2 }).catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(429);
		expect(calls.length).toBe(3); // initial + 2 retries
	});

	test("does NOT retry on a non-429 error", async () => {
		installFetchStub();
		script.push(() => makeResponse(500, { error: "boom" }));

		await expect(
			apiFetch("/api/test", { maxRetries: 2 }),
		).rejects.toBeInstanceOf(ApiError);
		expect(calls.length).toBe(1);
	});

	test("respects maxRetries: 0 (no retries)", async () => {
		installFetchStub();
		script.push(() => makeResponse(429, undefined, { "retry-after": "0" }));

		await expect(
			apiFetch("/api/test", { maxRetries: 0 }),
		).rejects.toBeInstanceOf(ApiError);
		expect(calls.length).toBe(1);
	});

	test("does NOT retry when caller aborts mid-backoff", async () => {
		installFetchStub();
		script.push(() => makeResponse(429, undefined, { "retry-after": "5" }));

		const controller = new AbortController();
		const promise = apiFetch("/api/test", {
			maxRetries: 2,
			signal: controller.signal,
		});
		// Abort before the first retry fires — the loop should exit
		// cleanly instead of waiting the full 5s Retry-After.
		setTimeout(() => controller.abort(), 10);

		await expect(promise).rejects.toBeInstanceOf(Error);
		expect(calls.length).toBe(1);
	});
});
