import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Characterization of the upstream release blocker, NOT A4 acceptance.
test("upstream converts invalid discriminator ProtocolError into a tool error without data", async () => {
	const server = new McpServer({
		name: "original-sdk-characterization",
		version: "1",
	});
	server.registerTool(
		"save_document",
		{ inputSchema: z.strictObject({ action: z.enum(["create", "update"]) }) },
		async () => ({ content: [{ type: "text", text: "unused" }] }),
	);
	const client = new Client({
		name: "validation-characterization",
		version: "1",
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	try {
		await Promise.all([server.connect(b), client.connect(a)]);
		const result = await client.callTool({
			name: "save_document",
			arguments: { action: "invalid" },
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "text", text: expect.stringContaining("Input validation error") },
		]);
	} finally {
		await client.close();
		await server.close();
	}
});
