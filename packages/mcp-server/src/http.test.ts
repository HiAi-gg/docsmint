import { expect, test } from "bun:test";
import { DocsClient } from "@hiai-docs/sdk";
import { createDocsmintMcpHttpHandler } from "./http.js";
import { createDocsmintMcpServer } from "./server.js";

function harness() {
	const seen: string[] = [];
	const urls: string[] = [];
	const handler = createDocsmintMcpHttpHandler({
		allowedOrigins: ["https://allowed.invalid"],
		createServer: async (request) => {
			urls.push(request.url);
			const key = request.headers.get("authorization");
			if (!key) return new Response(null, { status: 401 });
			const docsClient = new DocsClient({
				baseUrl: "https://api.invalid",
				retries: 1,
				fetch: (async () => {
					await Bun.sleep(key === "Bearer first" ? 10 : 1);
					seen.push(key);
					return Response.json([
						{
							id: key,
							name: key,
							order: 0,
							createdAt: "2026-01-01",
							updatedAt: "2026-01-01",
						},
					]);
				}) as unknown as typeof fetch,
			});
			return createDocsmintMcpServer({ docsClient });
		},
	});
	return { handler, seen, urls };
}
function rpc(
	method: string,
	key?: string,
	origin?: string,
	id: number | undefined = 1,
) {
	return new Request("http://localhost/mcp", {
		method: "POST",
		headers: {
			"MCP-Protocol-Version": "2025-06-18",
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(key ? { authorization: key } : {}),
			...(origin ? { origin } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			...(id === undefined ? {} : { id }),
			method,
			...(method === "tools/call"
				? {
						params: {
							name: "list_workspace_structure",
							arguments: { kind: "categories" },
						},
					}
				: {}),
		}),
	});
}
test("HTTP rejects foreign Origin, permits server clients and returns CORS on auth errors", async () => {
	const { handler, seen } = harness();
	expect(
		(
			await handler.fetch(
				rpc("tools/list", "Bearer first", "https://foreign.invalid"),
			)
		).status,
	).toBe(403);
	const denied = await handler.fetch(
		rpc("tools/list", undefined, "https://allowed.invalid"),
	);
	expect(denied.status).toBe(401);
	expect(denied.headers.get("Access-Control-Allow-Origin")).toBe(
		"https://allowed.invalid",
	);
	const allowed = await handler.fetch(rpc("tools/list", "Bearer first"));
	expect(allowed.status).toBe(200);
	expect(allowed.headers.get("Mcp-Session-Id")).toBeNull();
	expect(seen).toEqual([]);
});
test("HTTP stateless requests keep concurrent principals isolated", async () => {
	const { handler } = harness();
	const results = await Promise.all(
		["Bearer first", "Bearer second"].map(async (key) => {
			const response = await handler.fetch(rpc("tools/call", key));
			expect(response.status).toBe(200);
			const text = await response.text();
			const messages = response.headers
				.get("content-type")
				?.includes("text/event-stream")
				? text
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => JSON.parse(line.slice(5).trim()))
				: [JSON.parse(text)];
			const results = messages.filter(
				(message) => message.id === 1 && message.result,
			);
			expect(results).toHaveLength(1);
			expect(response.headers.get("Mcp-Session-Id")).toBeNull();
			return results[0].result.structuredContent;
		}),
	);
	expect(results[0].result[0].id).toBe("Bearer first");
	expect(results[1].result[0].id).toBe("Bearer second");
});
test("HTTP methods, preflight, notification and independent disable are explicit", async () => {
	const { handler } = harness();
	for (const method of ["GET", "DELETE"])
		expect(
			(await handler.fetch(new Request("http://localhost/mcp", { method })))
				.status,
		).toBe(405);
	const preflight = await handler.fetch(
		new Request("http://localhost/mcp", {
			method: "OPTIONS",
			headers: { origin: "https://allowed.invalid" },
		}),
	);
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
		"MCP-Protocol-Version",
	);
	const notification = new Request("http://localhost/mcp", {
		method: "POST",
		headers: {
			"MCP-Protocol-Version": "2025-06-18",
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: "Bearer first",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		}),
	});
	expect((await handler.fetch(notification)).status).toBe(202);
	const disabled = createDocsmintMcpHttpHandler({
		enabled: false,
		allowedOrigins: [],
		createServer: async () => {
			throw new Error("must not authenticate");
		},
	});
	expect((await disabled.fetch(rpc("tools/list"))).status).toBe(404);
});

test("HTTP initialize advertises the current server without a session", async () => {
	const { handler } = harness();
	const response = await handler.fetch(
		new Request("http://localhost/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: "Bearer first",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 8,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test", version: "1" },
				},
			}),
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Mcp-Session-Id")).toBeNull();
	const payload = await response.text();
	const messages = response.headers
		.get("content-type")
		?.includes("text/event-stream")
		? payload
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => JSON.parse(line.slice(5).trim()))
		: [JSON.parse(payload)];
	const data = messages.find((message) => message.id === 8);
	expect(data).toBeDefined();
	expect(data.result.serverInfo.name).toBe("docsmint");
	expect(data.result.capabilities.tools).toBeDefined();
});
test("HTTP authentication infrastructure failure is sanitized and keeps allowed CORS", async () => {
	const handler = createDocsmintMcpHttpHandler({
		allowedOrigins: ["https://allowed.invalid"],
		createServer: async () => {
			throw new Error("private connection detail");
		},
	});
	const response = await handler.fetch(
		rpc("tools/list", "Bearer first", "https://allowed.invalid"),
	);
	expect(response.status).toBe(500);
	expect(response.headers.get("access-control-allow-origin")).toBe(
		"https://allowed.invalid",
	);
	expect(await response.text()).not.toContain("private connection detail");
});

test("trailing slash is internally normalized without losing credentials or the RPC body", async () => {
	const { handler, seen, urls } = harness();
	const original = rpc("tools/call", "Bearer first");
	const response = await handler.fetch(
		new Request("http://localhost/mcp/", original),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("location")).toBeNull();
	expect(await response.text()).toContain("Bearer first");
	expect(seen).toEqual(["Bearer first"]);
	expect(urls).toEqual(["http://localhost/mcp"]);
});
