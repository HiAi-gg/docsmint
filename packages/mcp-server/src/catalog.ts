import {
	InMemoryTransport,
	type Tool,
	type Prompt,
	type Resource,
} from "@modelcontextprotocol/server";
import { DocsClient } from "@hiai-docs/sdk";
import { createDocsmintMcpServer } from "./server.js";

type JsonObject = Record<string, unknown>;
export interface DocsMintMcpDocumentationCatalog {
	server: { name: string; version: string };
	tools: Array<Tool & { examples: JsonObject[] }>;
	prompts: Prompt[];
	resources: Resource[];
}

function object(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}
function example(schema: JsonObject): unknown {
	if ("const" in schema) return schema.const;
	if (Array.isArray(schema.enum)) return schema.enum[0];
	if (Array.isArray(schema.anyOf)) return example(object(schema.anyOf[0]));
	if (schema.type === "null") return null;
	if (schema.type === "boolean") return false;
	if (schema.type === "number" || schema.type === "integer")
		return Math.max(1, Number(schema.minimum ?? 1));
	if (schema.type === "array") return [example(object(schema.items))];
	if (schema.type === "object" || schema.properties) {
		return Object.fromEntries(
			Object.entries(object(schema.properties))
				.filter(
					([name]) =>
						(Array.isArray(schema.required) &&
							schema.required.includes(name)) ||
						name === "title" ||
						name === "name",
				)
				.map(([name, value]) => [name, example(object(value))]),
		);
	}
	if (schema.format === "uuid") return "11111111-1111-4111-8111-111111111111";
	if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
	return "Example";
}

/** Derive public documentation through real MCP discovery, without credentials or network access. */
export async function generateDocsmintMcpCatalog(): Promise<DocsMintMcpDocumentationCatalog> {
	const docsClient = new DocsClient({
		baseUrl: "https://catalog.invalid",
		retries: 1,
		fetch: (async () => {
			throw new Error("Catalog generation must not access document storage");
		}) as unknown as typeof fetch,
	});
	const server = createDocsmintMcpServer({ docsClient });
	const [peer, transport] = InMemoryTransport.createLinkedPair();
	let id = 0;
	const waiting = new Map<
		number,
		{ resolve(value: JsonObject): void; reject(error: Error): void }
	>();
	peer.onmessage = (message) => {
		if (!("id" in message) || typeof message.id !== "number") return;
		const pending = waiting.get(message.id);
		if (!pending) return;
		waiting.delete(message.id);
		if ("error" in message)
			pending.reject(new Error("MCP catalog discovery failed"));
		else if ("result" in message) pending.resolve(object(message.result));
	};
	async function rpc(
		method: string,
		params: JsonObject = {},
	): Promise<JsonObject> {
		const requestId = ++id;
		const result = new Promise<JsonObject>((resolve, reject) =>
			waiting.set(requestId, { resolve, reject }),
		);
		await peer.send({ jsonrpc: "2.0", id: requestId, method, params });
		return result;
	}
	async function collect(method: string, field: string): Promise<unknown[]> {
		const values: unknown[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await rpc(method, cursor ? { cursor } : {});
			if (!Array.isArray(page[field]))
				throw new Error(`Invalid ${method} discovery result`);
			values.push(...page[field]);
			cursor =
				typeof page.nextCursor === "string" ? page.nextCursor : undefined;
			if (cursor && seen.has(cursor))
				throw new Error(`Repeated ${method} discovery cursor`);
			if (cursor) seen.add(cursor);
		} while (cursor);
		return values;
	}
	try {
		await Promise.all([peer.start(), server.connect(transport)]);
		const initialized = await rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "docsmint-catalog-generator", version: "1" },
		});
		await peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		const tools = (await collect("tools/list", "tools")) as Tool[];
		const prompts = (await collect("prompts/list", "prompts")) as Prompt[];
		const resources = (await collect(
			"resources/list",
			"resources",
		)) as Resource[];
		const info = object(initialized.serverInfo);
		if (typeof info.name !== "string" || typeof info.version !== "string")
			throw new Error("Missing MCP server identity");
		return {
			server: { name: info.name, version: info.version },
			tools: tools.map((tool) => {
				const schema = object(tool.inputSchema);
				const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [schema];
				return {
					...tool,
					examples: branches.map((branch) => object(example(object(branch)))),
				};
			}),
			prompts,
			resources,
		};
	} finally {
		await peer.close();
		await server.close();
	}
}
