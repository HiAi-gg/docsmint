import { afterEach, describe, expect, it } from "bun:test";
import {
	DocsApiError,
	DocsClient,
	DocsTimeoutError,
	type DocsClientConfig,
} from "./index.js";

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers).entries()) },
	});

const clients: DocsClient[] = [];

afterEach(() => {
	clients.length = 0;
});

function client(fetchImpl: NonNullable<DocsClientConfig["fetch"]>, extra: Partial<DocsClientConfig> = {}): DocsClient {
	const instance = new DocsClient({
		baseUrl: "https://docs.example.test/",
		apiKey: "api-key",
		fetch: fetchImpl,
		retries: 1,
		...extra,
	});
	clients.push(instance);
	return instance;
}

describe("DocsClient public contract", () => {
	it("forwards api key and request context while building typed category requests", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const docs = client(async (input, init) => {
			seen = { url: String(input), init: init ?? {} };
			return jsonResponse([]);
		});

		await docs.listCategories({
			authorization: "Bearer session-token",
			cookie: "better-auth.session_token=session",
			requestId: "req-123",
			headers: { "x-tenant-id": "tenant-a" },
		});

		expect(seen?.url).toBe("https://docs.example.test/api/categories");
		expect(new Headers(seen?.init.headers).get("authorization")).toBe("Bearer session-token");
		expect(new Headers(seen?.init.headers).get("cookie")).toBe("better-auth.session_token=session");
		expect(new Headers(seen?.init.headers).get("x-request-id")).toBe("req-123");
		expect(new Headers(seen?.init.headers).get("x-tenant-id")).toBe("tenant-a");
	});

	it("merges default request context with per-call context", async () => {
		let seenHeaders: Headers | undefined;
		const docs = client(async (_input, init) => {
			seenHeaders = new Headers(init?.headers);
			return jsonResponse({ status: "ok", service: "hiai-docs", timestamp: new Date().toISOString() });
		}, {
			requestContext: { cookie: "base-cookie", headers: { "x-base": "yes" } },
		});

		await docs.withRequestContext({ requestId: "req-456", headers: { "x-call": "yes" } }).health();
		expect(seenHeaders?.get("cookie")).toBe("base-cookie");
		expect(seenHeaders?.get("x-base")).toBe("yes");
		expect(seenHeaders?.get("x-call")).toBe("yes");
		expect(seenHeaders?.get("x-request-id")).toBe("req-456");
	});

	it("encodes search filters and returns the response contract", async () => {
		let seenUrl = "";
		const docs = client(async (input) => {
			seenUrl = String(input);
			return jsonResponse({ items: [], total: 0, page: 1, limit: 20 });
		});

		await docs.search("road map", {
			category: "cat/one",
			graph: true,
			graphHops: 2,
			graphBoost: 0.75,
			includeChunks: true,
		});
		expect(seenUrl).toContain("q=road+map");
		expect(seenUrl).toContain("category=cat%2Fone");
		expect(seenUrl).toContain("graph=true");
		expect(seenUrl).toContain("graphHops=2");
		expect(seenUrl).toContain("graphBoost=0.75");
		expect(seenUrl).toContain("includeChunks=true");
	});

	it("supports commenter share links and graph metadata endpoints", async () => {
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		const docs = client(async (input, init) => {
			calls.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
			if (String(input).includes("/api/graph/entities")) return jsonResponse({ entities: [{ name: "Ada", type: "Person" }] });
			if (String(input).includes("/api/graph/related/")) return jsonResponse({ related: [{ docId: "doc-2", relationType: "MENTIONS", hopDistance: 2 }] });
			if (String(input).includes("/api/graph/search")) return jsonResponse({ query: "road map", entities: [], relatedDocs: [] });
			return jsonResponse({
				id: "share-1",
				token: "token",
				documentId: "doc-1",
				folderId: null,
				role: "commenter",
				expiresAt: null,
				hasPassword: false,
				createdAt: "now",
			});
		});

		const share = await docs.createShare({ documentId: "doc-1", role: "commenter" });
		await docs.updateShare("share-1", { role: "commenter" });
		await docs.getGraphEntities("doc-1");
		await docs.getRelatedDocuments("doc-1");
		await docs.graphSearch({ query: "road map", docIds: ["doc-1"], maxResults: 5 });

		expect(share.role).toBe("commenter");
		expect(calls[0]?.body).toContain('"role":"commenter"');
		expect(calls[1]?.method).toBe("PATCH");
		expect(calls[2]?.url).toContain("docId=doc-1");
		expect(calls[3]?.url).toContain("/api/graph/related/doc-1");
		expect(calls[4]?.method).toBe("POST");
	});

	it("throws DocsApiError with status and parsed body", async () => {
		const docs = client(async () => jsonResponse({ error: "Forbidden" }, 403, { "x-request-id": "req-403" }));
		try {
			await docs.getDoc("doc-1");
			throw new Error("expected getDoc to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(DocsApiError);
			if (!(error instanceof DocsApiError)) return;
			expect(error.status).toBe(403);
			expect(error.message).toBe("Forbidden");
			expect((error.body as { error: string }).error).toBe("Forbidden");
		}
	});

	it("retries transient responses and then returns the success payload", async () => {
		let attempts = 0;
		const docs = client(async () => {
			attempts += 1;
			return attempts === 1 ? jsonResponse({ error: "busy" }, 503) : jsonResponse({ status: "ok", service: "hiai-docs", timestamp: "now" });
		}, { retries: 2, retryBackoffMs: 0 });

		await expect(docs.health()).resolves.toMatchObject({ status: "ok" });
		expect(attempts).toBe(2);
	});

	it("exposes a timeout-specific error contract", async () => {
		const docs = client(async (_input, init) => {
			await new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true });
			});
			return jsonResponse({});
		}, { timeout: 1 });

		await expect(docs.health()).rejects.toBeInstanceOf(DocsTimeoutError);
	});

	it("propagates caller cancellation without retrying or converting to timeout", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const abortError = new DOMException("cancelled", "AbortError");
		const docs = client(async (_input, init) => {
			attempts += 1;
			controller.abort(abortError);
			// A real fetch may reject with a runtime-created AbortError rather
			// than the caller's reason. The client must preserve the reason.
			void init;
			throw new DOMException("transport aborted", "AbortError");
		}, { requestContext: { signal: controller.signal }, retries: 3, retryBackoffMs: 0 });

		await expect(docs.health()).rejects.toBe(abortError);
		expect(attempts).toBe(1);
	});
});
