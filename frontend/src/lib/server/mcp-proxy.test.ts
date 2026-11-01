import { expect, spyOn, test } from "bun:test";
import { createDocsmintMcpHttpHandler } from "../../../../packages/mcp-server/src/http";
import { createDocsmintMcpServer } from "../../../../packages/mcp-server/src/server";
import { OPTIONS, POST, trailingSlash } from "../../routes/mcp/+server";
import { proxyMcpRequest } from "./mcp-proxy";

test("public MCP proxy preserves the RPC body and Bearer without forwarding browser/operator authority", async () => {
	let forwarded: Request | undefined;
	const payload = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/list",
		params: { marker: "Unicode 🚀" },
	});
	const response = await proxyMcpRequest(
		new Request("https://docs.example.invalid/mcp/?test=1", {
			method: "POST",
			headers: {
				authorization: "Bearer synthetic",
				cookie: "session=owner",
				"x-api-key": "operator",
				"x-docsmint-workspace-context": "assertion",
				"content-type": "application/json",
				"MCP-Protocol-Version": "2025-06-18",
				origin: "https://docs.example.invalid",
			},
			body: payload,
		}),
		{
			apiBaseUrl: "http://api:50700",
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				forwarded = new Request(input, init);
				return Response.json(
					{ error: "Denied" },
					{
						status: 401,
						headers: {
							"WWW-Authenticate": "Bearer",
							"Access-Control-Allow-Origin": "https://docs.example.invalid",
							Vary: "Origin",
						},
					},
				);
			}) as unknown as typeof fetch,
		},
	);
	expect(forwarded?.url).toBe("http://api:50700/mcp?test=1");
	expect(await forwarded?.text()).toBe(payload);
	expect(forwarded?.headers.get("authorization")).toBe("Bearer synthetic");
	expect(forwarded?.headers.get("origin")).toBe("https://docs.example.invalid");
	expect(forwarded?.headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
	for (const name of ["cookie", "x-api-key", "x-docsmint-workspace-context"])
		expect(forwarded?.headers.get(name)).toBeNull();
	expect(response.status).toBe(401);
	expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
		"https://docs.example.invalid",
	);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({ error: "Denied" });
});

test("public MCP proxy preserves streaming responses without waiting for the SSE stream to close", async () => {
	let cancelled = false;
	const source = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
				),
			);
		},
	});
	const response = await proxyMcpRequest(
		new Request("https://docs.example.invalid/mcp"),
		{
			apiBaseUrl: "http://api:50700",
			fetch: (async () =>
				new Response(source, {
					headers: { "content-type": "text/event-stream" },
				})) as unknown as typeof fetch,
		},
	);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	const reader = response.body?.getReader();
	expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
		'"jsonrpc":"2.0"',
	);
	await reader?.cancel();
	expect(cancelled).toBe(true);
}, 2000);

test("public MCP proxy is manual-redirect and preserves the backend method/status contract", async () => {
	for (const status of [202, 204, 400, 403, 405]) {
		const response = await proxyMcpRequest(
			new Request("https://docs.example.invalid/mcp", { method: "OPTIONS" }),
			{
				apiBaseUrl: "http://api:50700",
				fetch: (async (_input: unknown, init?: RequestInit) => {
					expect(init?.redirect).toBe("manual");
					expect(init?.method).toBe("OPTIONS");
					return new Response(null, {
						status,
						headers: {
							Allow: "POST, OPTIONS",
							Vary: "Origin",
							"Access-Control-Allow-Methods": "POST, OPTIONS",
						},
					});
				}) as unknown as typeof fetch,
			},
		);
		expect(response.status).toBe(status);
		expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
		expect(response.headers.get("Vary")).toBe("Origin");
	}
});

test("public web ingress reaches the real HTTP MCP transport with unchanged authorization errors", async () => {
	const backend = createDocsmintMcpHttpHandler({
		allowedOrigins: ["https://docs.example.invalid"],
		createServer: async (request) =>
			request.headers.get("authorization") === "Bearer synthetic"
				? createDocsmintMcpServer()
				: new Response(null, {
						status: 401,
						headers: { "WWW-Authenticate": "Bearer" },
					}),
	});
	const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		backend.fetch(
			new Request(input, init),
		)) as unknown as typeof globalThis.fetch;
	try {
		for (const path of ["/mcp", "/mcp/"]) {
			const response = await proxyMcpRequest(
				new Request("https://docs.example.invalid" + path, {
					method: "POST",
					headers: {
						authorization: "Bearer synthetic",
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				}),
				{ apiBaseUrl: "http://api:50700", fetch },
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("location")).toBeNull();
			expect(await response.text()).toContain("find_documents");
		}
		const denied = await proxyMcpRequest(
			new Request("https://docs.example.invalid/mcp", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
			{ apiBaseUrl: "http://api:50700", fetch },
		);
		expect(denied.status).toBe(401);
		expect(denied.headers.get("WWW-Authenticate")).toBe("Bearer");
		const origin = await proxyMcpRequest(
			new Request("https://docs.example.invalid/mcp", {
				method: "POST",
				headers: {
					origin: "https://foreign.invalid",
					authorization: "Bearer synthetic",
				},
				body: "{}",
			}),
			{ apiBaseUrl: "http://api:50700", fetch },
		);
		expect(origin.status).toBe(403);
	} finally {
		await backend.close();
	}
});

test("SvelteKit public route exports pass POST and OPTIONS through without a redirect", async () => {
	expect(trailingSlash).toBe("ignore");
	let calls = 0;
	let eventFetchCalls = 0;
	const fetch = (async (_url: unknown, init?: RequestInit) => {
		calls++;
		expect(
			init?.headers instanceof Headers && init.headers.get("authorization"),
		).toBe("Bearer synthetic");
		expect(init?.redirect).toBe("manual");
		return new Response(null, {
			status: init?.method === "OPTIONS" ? 204 : 401,
			headers: {
				"WWW-Authenticate": "Bearer",
				"Access-Control-Allow-Headers": "Authorization",
			},
		});
	}) as unknown as typeof globalThis.fetch;
	const rawFetch = spyOn(globalThis, "fetch").mockImplementation(fetch);
	try {
		for (const [method, handler, status] of [
			["POST", POST, 401],
			["OPTIONS", OPTIONS, 204],
		] as const) {
			const response = await handler({
				request: new Request("https://docs.example.invalid/mcp/", {
					method,
					headers: { authorization: "Bearer synthetic" },
				}),
				fetch: async () => {
					eventFetchCalls++;
					throw new Error("event.fetch must not inject MCP Origin");
				},
			} as never);
			expect(response.status).toBe(status);
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
		}
		expect(calls).toBe(2);
		expect(eventFetchCalls).toBe(0);
	} finally {
		rawFetch.mockRestore();
	}
});

test("public MCP proxy propagates abort signals and sanitizes upstream failures", async () => {
	const controller = new AbortController();
	const request = new Request("https://docs.example.invalid/mcp", {
		signal: controller.signal,
	});
	const pending = proxyMcpRequest(request, {
		apiBaseUrl: "http://api:50700",
		fetch: (async (_url: unknown, init?: RequestInit) => {
			expect(init?.signal).toBe(request.signal);
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener(
					"abort",
					() => reject(new Error("private upstream detail")),
					{ once: true },
				),
			);
		}) as unknown as typeof fetch,
	});
	controller.abort();
	const response = await pending;
	expect(response.status).toBe(502);
	expect(await response.text()).not.toContain("private upstream detail");
});

test("public MCP proxy drops stale compression framing from Fetch-decoded bodies", async () => {
	const response = await proxyMcpRequest(
		new Request("https://docs.example.invalid/mcp"),
		{
			apiBaseUrl: "http://api:50700",
			fetch: (async () =>
				new Response('{"jsonrpc":"2.0"}', {
					headers: {
						"content-type": "application/json",
						"content-encoding": "gzip",
						"content-length": "999",
					},
				})) as unknown as typeof fetch,
		},
	);
	expect(response.headers.get("content-encoding")).toBeNull();
	expect(response.headers.get("content-length")).toBeNull();
	expect(await response.json()).toEqual({ jsonrpc: "2.0" });
});
