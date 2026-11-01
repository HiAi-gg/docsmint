import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { DocsClient } from "@hiai-docs/sdk";
import { DocsMintMcpServer } from "./argument-diagnostics.js";
import { createMcpDocsClient } from "./client.js";
import {
	createDocsmintMcpServer,
	registerDocsmintMcpCapabilities,
} from "./server.js";
import { createDocsmintMcpHttpHandler } from "./http.js";

function endpoint(decorated: boolean, storageStatus = 200) {
	let calls = 0;
	return {
		calls: () => calls,
		handler: createDocsmintMcpHttpHandler({
			allowedOrigins: ["https://allowed.example"],
			createServer: async (request) => {
				if (request.headers.get("authorization") !== "Bearer fixture")
					return Response.json({ error: "Unauthorized" }, { status: 401 });
				const Constructor = decorated ? DocsMintMcpServer : McpServer;
				const server = new Constructor({ name: "docsmint", version: "1" });
				registerDocsmintMcpCapabilities(
					server,
					createMcpDocsClient(
						new DocsClient({
							baseUrl: "https://storage.invalid",
							retries: 1,
							fetch: (async () => {
								calls++;
								return Response.json(
									storageStatus === 200
										? []
										: { error: "Denied", code: "FORBIDDEN" },
									{ status: storageStatus },
								);
							}) as unknown as typeof fetch,
						}),
					),
				);
				return server;
			},
		}),
	};
}
function request(
	method: string,
	body?: unknown,
	authorization = "Bearer fixture",
	origin?: string,
) {
	return new Request("https://docsmint.example/mcp", {
		method,
		headers: {
			authorization,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
			...(origin ? { origin } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
test("HTTP invalid-argument calls get scoped redacted diagnostics concurrently without storage", async () => {
	const endpointFixture = endpoint(true);
	const [a, b] = await Promise.all([
		endpointFixture.handler.fetch(
			request("POST", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "save_document",
					arguments: { action: "secret-credential" },
				},
			}),
		),
		endpointFixture.handler.fetch(
			request("POST", {
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: {
					name: "read_document",
					arguments: { view: "detail", id: "secret-document" },
				},
			}),
		),
	]);
	async function payload(response: Response) {
		const text = await response.text();
		const data = text.split("\n").find((line) => line.startsWith("data: "));
		return JSON.parse(data ? data.slice(6) : text) as unknown;
	}
	const first = await payload(a),
		second = await payload(b);
	expect(first).toMatchObject({
		id: 1,
		error: { code: -32602, data: { tool: "save_document", branch: null } },
	});
	expect(second).toMatchObject({
		id: 2,
		error: { code: -32602, data: { tool: "read_document", branch: "detail" } },
	});
	expect(JSON.stringify([first, second])).not.toContain("secret-");
	expect(endpointFixture.calls()).toBe(0);
	expect(a.headers.get("Mcp-Session-Id")).toBeNull();
});
test("HTTP original and decorated transports preserve auth, origin, method and protocol responses", async () => {
	for (const status of [200, 403]) {
		const original = endpoint(false, status),
			decorated = endpoint(true, status);
		const cases = [
			() =>
				request("POST", {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "list_workspace_structure",
						arguments: { kind: "categories" },
					},
				}),
			() =>
				request("POST", {
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "unknown", arguments: {} },
				}),
			() => request("POST", { invalid: "protocol-envelope" }),
			() =>
				request("POST", {
					jsonrpc: "2.0",
					id: 3,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "matrix", version: "1" },
					},
				}),
			() =>
				request(
					"POST",
					{ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
					"invalid",
				),
			() =>
				request(
					"POST",
					{ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
					"Bearer fixture",
					"https://denied.example",
				),
			() => request("GET"),
			() => request("DELETE"),
			() =>
				request("POST", {
					jsonrpc: "2.0",
					method: "notifications/initialized",
				}),
		];
		for (const make of cases) {
			const a = await original.handler.fetch(make()),
				b = await decorated.handler.fetch(make());
			expect(b.status).toBe(a.status);
			expect(await b.text()).toBe(await a.text());
			expect([...b.headers]).toEqual([...a.headers]);
		}
		expect(decorated.calls()).toBe(original.calls());
	}
});

test("public HTTP and server factories return redacted argument diagnostics before storage", async () => {
	let calls = 0;
	const handler = createDocsmintMcpHttpHandler({
		allowedOrigins: ["https://allowed.example"],
		createServer: async () =>
			createDocsmintMcpServer({
				docsClient: new DocsClient({
					baseUrl: "https://must-not-fetch.invalid",
					retries: 1,
					fetch: (async () => {
						calls++;
						throw new Error("Unexpected document access");
					}) as unknown as typeof fetch,
				}),
			}),
	});
	try {
		const response = await handler.fetch(
			request("POST", {
				jsonrpc: "2.0",
				id: 99,
				method: "tools/call",
				params: {
					name: "save_document",
					arguments: {
						action: "secret-action",
						content: "secret-document-content",
					},
				},
			}),
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		const data = text.split("\n").find((line) => line.startsWith("data: "));
		const result = JSON.parse(data ? data.slice(6) : text) as unknown;
		expect(result).toMatchObject({
			id: 99,
			error: {
				code: -32602,
				data: {
					tool: "save_document",
					branch: null,
					expectedArgs: expect.any(Array),
					issues: expect.any(Array),
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("secret-action");
		expect(JSON.stringify(result)).not.toContain("secret-document-content");
		expect(calls).toBe(0);
	} finally {
		await handler.close();
	}
});
