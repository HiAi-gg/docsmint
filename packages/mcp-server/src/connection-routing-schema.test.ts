import { afterEach, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import Ajv2020 from "ajv/dist/2020.js";
import { createDocsmintMcpServer } from "./server.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

test("published operation schemas accept client routing properties without admitting unrelated operation fields", async () => {
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const server = createDocsmintMcpServer();
	const client = new Client({
		name: "connection-routing-test",
		version: "1.0.0",
	});
	close = async () => {
		await client.close();
		await server.close();
	};
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	const tools = (await client.listTools()).tools;
	const validator = new Ajv2020({ strict: false, validateFormats: false });
	const examples: Record<string, Record<string, unknown>> = {
		list_workspace_structure: { kind: "folders" },
		find_documents: { mode: "search", query: "synthetic routing fixture" },
		read_document: {
			view: "detail",
			id: "11111111-1111-4111-8111-111111111111",
		},
		batch_documents: {
			action: "trash",
			documentIds: ["11111111-1111-4111-8111-111111111111"],
		},
	};
	for (const [name, input] of Object.entries(examples)) {
		const tool = tools.find((entry) => entry.name === name);
		if (!tool) throw new Error(`Missing expected tool: ${name}`);
		const schema = structuredClone(tool.inputSchema);
		const original = validator.compile(schema);
		expect(original(input), `${name}: original input`).toBe(true);
		expect(
			original({ ...input, unexpected: true }),
			`${name}: unknown provider input`,
		).toBe(false);
		const routedSchema = {
			...schema,
			properties: { ...schema.properties, link_id: { type: "string" } },
			required: [...(schema.required ?? []), "link_id"],
		};
		const routed = validator.compile(routedSchema);
		expect(
			routed({ ...input, link_id: "synthetic-link" }),
			`${name}: injected connection selector`,
		).toBe(true);
		expect(routed(input), `${name}: missing connection selector`).toBe(false);
		expect(
			routed({ ...input, link_id: "synthetic-link", unexpected: true }),
			`${name}: unknown routed input`,
		).toBe(false);
		if (name === "find_documents") {
			expect(
				routed({
					mode: "list",
					query: "inappropriate search field",
					link_id: "synthetic-link",
				}),
			).toBe(false);
		}
		if (name === "batch_documents") {
			expect(
				routed({ ...input, folderId: null, link_id: "synthetic-link" }),
			).toBe(false);
		}
	}
});
