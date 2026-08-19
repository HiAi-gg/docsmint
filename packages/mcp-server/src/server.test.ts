import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { capabilityCatalog } from "./capabilities.js";
import { createDocsmintMcpServer } from "./server.js";

describe("DocsMint MCP protocol discovery", () => {
	let close: (() => Promise<void>) | undefined;
	afterEach(async () => close?.());

	test("advertises tools, prompts, and resources over MCP", async () => {
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const server = createDocsmintMcpServer();
		const client = new Client({ name: "contract-test", version: "1.0.0" });
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		close = async () => {
			await client.close();
			await server.close();
		};

		const tools = await client.listTools();
		const prompts = await client.listPrompts();
		const resources = await client.listResources();
		const prompt = await client.getPrompt({
			name: "research_workspace",
			arguments: { question: "What changed?", language: "English" },
		});
		const guide = await client.readResource({ uri: "docsmint://guide/search" });

		expect(tools.tools.map((tool) => tool.name)).toEqual([
			...capabilityCatalog.tools,
		]);
		expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
			"organize_workspace",
			"research_workspace",
		]);
		expect(resources.resources.map((resource) => resource.uri)).toEqual([
			"docsmint://guide/editor",
			"docsmint://guide/search",
			"docsmint://workspace/catalog",
		]);
		expect(prompt.messages[0]?.content).toMatchObject({
			type: "text",
			text: expect.stringContaining("What changed?"),
		});
		expect(guide.contents[0]).toMatchObject({
			uri: "docsmint://guide/search",
			text: expect.stringContaining("multilingual queries"),
		});
	});
});
