import { expect, test } from "bun:test";
import {
	InMemoryTransport,
	McpServer,
	type Transport,
	type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { DocsClient } from "@hiai-docs/sdk";
import { z } from "zod";
import { createMcpDocsClient } from "./client.js";
import { registerDocsmintMcpCapabilities } from "./server.js";
import {
	captureMcpInputSchema,
	decorateMcpArgumentTransport,
} from "./argument-diagnostics.js";
import { withClientRoutingSchema } from "./client-routing-schema.js";

async function harness(
	decorated: boolean,
	status = 200,
	maxToolInputElements?: number,
) {
	let storageCalls = 0;
	const server = new McpServer(
		{ name: "docsmint", version: "1" },
		{ maxToolInputElements },
	);
	registerDocsmintMcpCapabilities(
		server,
		createMcpDocsClient(
			new DocsClient({
				baseUrl: "https://fixture.invalid",
				retries: 1,
				fetch: (async () => {
					storageCalls++;
					return Response.json(
						status === 200 ? [] : { error: "Access denied", code: "FORBIDDEN" },
						{ status },
					);
				}) as unknown as typeof fetch,
			}),
		),
	);
	server
		.registerTool(
			"disabled",
			{
				inputSchema: captureMcpInputSchema(
					server,
					"disabled",
					withClientRoutingSchema(z.strictObject({ id: z.string().uuid() })),
				),
			},
			async () => ({ content: [{ type: "text", text: "never called" }] }),
		)
		.disable();
	const [peer, transport] = InMemoryTransport.createLinkedPair();
	const waiting = new Map<number, (value: unknown) => void>();
	peer.onmessage = (message) => {
		if ("id" in message && typeof message.id === "number")
			waiting.get(message.id)?.(message);
	};
	let next = 0;
	async function rpc(method: string, params: Record<string, unknown> = {}) {
		const id = ++next;
		const response = new Promise<unknown>((resolve) =>
			waiting.set(id, resolve),
		);
		await peer.send({ jsonrpc: "2.0", id, method, params });
		return response;
	}
	await Promise.all([
		peer.start(),
		server.connect(
			decorated ? decorateMcpArgumentTransport(transport, server) : transport,
		),
	]);
	await rpc("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "diagnostics-test", version: "1" },
	});
	await peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	return {
		rpc,
		server,
		calls: () => storageCalls,
		close: async () => {
			await peer.close();
			await server.close();
		},
	};
}

test("invalid registered arguments become redacted -32602 without accessing storage", async () => {
	const connection = await harness(true);
	try {
		const secret = "Bearer do-not-echo-this-secret";
		const result = await connection.rpc("tools/call", {
			name: "save_document",
			arguments: { action: secret, content: secret, [secret]: secret },
		});
		expect(result).toMatchObject({
			error: {
				code: -32602,
				message: "Invalid tool arguments",
				data: {
					tool: "save_document",
					branch: null,
					expectedArgs: expect.any(Array),
					issues: expect.any(Array),
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(connection.calls()).toBe(0);
		const known = await connection.rpc("tools/call", {
			name: "save_document",
			arguments: { action: "update", id: "invalid-secret-id" },
		});
		expect(known).toMatchObject({
			error: {
				data: {
					branch: "update",
					issues: expect.arrayContaining([
						expect.objectContaining({ path: ["id"] }),
					]),
				},
			},
		});
		expect(JSON.stringify(known)).not.toContain("invalid-secret-id");
	} finally {
		await connection.close();
	}
});

test("valid responses, unknown tools, malformed envelopes and access errors equal original SDK bytes", async () => {
	for (const status of [200, 401, 403]) {
		const a = await harness(false, status),
			b = await harness(true, status);
		try {
			for (const [method, params] of [
				[
					"tools/call",
					{
						name: "list_workspace_structure",
						arguments: { kind: "categories" },
					},
				],
				["tools/call", { name: "unknown-tool", arguments: {} }],
				["tools/call", { name: "disabled", arguments: { id: "malformed" } }],
				["tools/call", { arguments: {} }],
				["unknown/method", {}],
			] as const)
				expect(JSON.stringify(await b.rpc(method, params))).toBe(
					JSON.stringify(await a.rpc(method, params)),
				);
			expect(b.calls()).toBe(a.calls());
		} finally {
			await a.close();
			await b.close();
		}
	}
});

class SpyTransport implements Transport {
	messages: Array<{
		message: JSONRPCMessage;
		options: Parameters<Transport["send"]>[1];
	}> = [];
	onmessage?: Transport["onmessage"];
	onclose?: Transport["onclose"];
	sessionId = "session-preserved";
	hasPerRequestStream = true;
	#marker = "bound";
	marker() {
		return this.#marker;
	}
	async start() {}
	async close() {
		this.onclose?.();
	}
	async send(
		message: JSONRPCMessage,
		options?: Parameters<Transport["send"]>[1],
	) {
		this.messages.push({ message, options });
	}
}
function spy() {
	const server = new McpServer({ name: "spy", version: "1" });
	captureMcpInputSchema(
		server,
		"example",
		withClientRoutingSchema(
			z.strictObject({
				action: z.enum(["read", "write"]),
				id: z.string().uuid(),
			}),
		),
	);
	const target = new SpyTransport();
	const decorated = decorateMcpArgumentTransport(target, server);
	decorated.onmessage = () => {};
	const request = (id: number, method = "tools/call") =>
		target.onmessage?.({
			jsonrpc: "2.0",
			id,
			method,
			params: { name: "example", arguments: { action: "read", id: "wrong" } },
		});
	const failure = (id: number): JSONRPCMessage => ({
		jsonrpc: "2.0",
		id,
		result: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Input validation error: Invalid arguments for tool example: validation failed",
				},
			],
		},
	});
	return { server, target, decorated, request, failure };
}
test("duplicate IDs stay ambiguous through out-of-order responses and later ID reuse works", async () => {
	const s = spy();
	s.request(1, "unknown/method");
	s.request(1);
	const first = s.failure(1);
	await s.decorated.send(first);
	expect(s.target.messages[0]?.message).toBe(first);
	s.request(1);
	const second = s.failure(1),
		third = s.failure(1);
	await s.decorated.send(second);
	await s.decorated.send(third);
	expect(s.target.messages[1]?.message).toBe(second);
	expect(s.target.messages[2]?.message).toBe(third);
	s.request(1);
	await s.decorated.send(s.failure(1));
	expect(s.target.messages[3]?.message).toHaveProperty("error.code", -32602);
});
test("public transport methods, session metadata and send options retain identity and this binding", async () => {
	const s = spy();
	expect(s.decorated.sessionId).toBe(s.target.sessionId);
	expect(s.decorated.hasPerRequestStream).toBe(true);
	expect((s.decorated as SpyTransport).marker()).toBe("bound");
	const options = { relatedRequestId: 4 };
	s.request(4);
	await s.decorated.send(s.failure(4), options);
	expect(s.target.messages[0]?.options).toBe(options);
});
test("capacity, close, other content and max-element failures pass through unchanged", async () => {
	const s = spy();
	for (let i = 0; i < 1024; i++) s.request(i, "unknown/method");
	s.request(2000);
	const overflow = s.failure(2000);
	await s.decorated.send(overflow);
	expect(s.target.messages[0]?.message).toBe(overflow);
	await s.decorated.close();
	s.request(3000);
	const extra = {
		...s.failure(3000),
		result: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Invalid arguments for tool example: arguments contain more than the maximum of 2 elements",
				},
			],
		},
	} as JSONRPCMessage;
	await s.decorated.send(extra);
	expect(s.target.messages[1]?.message).toBe(extra);
	s.request(3001);
	const structured = {
		...s.failure(3001),
		result: {
			isError: true,
			structuredContent: {},
			content: [
				{
					type: "text",
					text: "Input validation error: Invalid arguments for tool example: invalid",
				},
			],
		},
	} as JSONRPCMessage;
	await s.decorated.send(structured);
	expect(s.target.messages[2]?.message).toBe(structured);
});

test("the actual SDK maximum-element guard is byte-identical and never enriched", async () => {
	const a = await harness(false, 200, 2),
		b = await harness(true, 200, 2);
	try {
		const args = {
			name: "save_document",
			arguments: {
				action: "update",
				id: "invalid",
				title: "extra",
				content: "extra",
			},
		};
		const original = await a.rpc("tools/call", args),
			decorated = await b.rpc("tools/call", args);
		expect(JSON.stringify(decorated)).toBe(JSON.stringify(original));
		expect(decorated).toMatchObject({ result: { isError: true } });
		expect(a.calls()).toBe(0);
		expect(b.calls()).toBe(0);
	} finally {
		await a.close();
		await b.close();
	}
});
test("a new duplicate during asynchronous revalidation prevents enrichment of all responses", async () => {
	const s = spy();
	let finish: ((value: unknown) => void) | undefined;
	const validating = new Promise<unknown>((resolve) => {
		finish = resolve;
	});
	captureMcpInputSchema(s.server, "example", {
		"~standard": {
			validate: () => validating,
			jsonSchema: {
				input: () => ({
					type: "object",
					properties: { id: { type: "string" } },
				}),
			},
		},
	});
	s.request(8);
	const first = s.failure(8);
	const sending = s.decorated.send(first);
	s.request(8);
	finish?.({ issues: [{ path: ["id"], code: "invalid_type" }] });
	await sending;
	const second = s.failure(8);
	await s.decorated.send(second);
	expect(s.target.messages[0]?.message).toBe(first);
	expect(s.target.messages[1]?.message).toBe(second);
});
test("unexpected validator exceptions and closed connections preserve the original SDK response", async () => {
	const s = spy();
	captureMcpInputSchema(s.server, "example", {
		"~standard": {
			validate: () => {
				throw new Error("unexpected private exception");
			},
			jsonSchema: { input: () => ({}) },
		},
	});
	s.request(1);
	const failure = s.failure(1);
	await s.decorated.send(failure);
	expect(s.target.messages[0]?.message).toBe(failure);
	await s.decorated.close();
	s.request(2);
	const afterClose = s.failure(2);
	await s.decorated.send(afterClose);
	expect(s.target.messages[1]?.message).toBe(afterClose);
});

test("cancellation notifications and request metadata reach the public transport unchanged", () => {
	const s = spy();
	const seen: unknown[] = [];
	s.decorated.onmessage = (message, extra) => {
		seen.push(message, extra);
	};
	const notification: JSONRPCMessage = {
		jsonrpc: "2.0",
		method: "notifications/cancelled",
		params: { requestId: 4, reason: "cancelled" },
	};
	const metadata = {
		request: new Request("https://example.invalid"),
		authInfo: { token: "fixture" },
	};
	s.target.onmessage?.(notification, metadata as never);
	expect(seen[0]).toBe(notification);
	expect(seen[1]).toBe(metadata);
});

test("unexpected incoming shapes still reach the original SDK callback unchanged", () => {
	const s = spy();
	let received: unknown = "unset";
	s.decorated.onmessage = (message) => {
		received = message;
	};
	expect(() => s.target.onmessage?.(null as never)).not.toThrow();
	expect(received).toBeNull();
});

test("throwing sends preserve the exact original error and release their request ID", async () => {
	const s = spy();
	const originalSend = s.target.send.bind(s.target);
	const sendError = new Error("original transport send failure");
	s.target.send = async () => {
		throw sendError;
	};
	s.request(77);
	await expect(s.decorated.send(s.failure(77))).rejects.toBe(sendError);
	expect(s.target.messages).toHaveLength(0);
	s.target.send = originalSend;
	s.request(77);
	await s.decorated.send(s.failure(77));
	expect(s.target.messages).toHaveLength(1);
	expect(s.target.messages[0]?.message).toHaveProperty("error.code", -32602);
});
