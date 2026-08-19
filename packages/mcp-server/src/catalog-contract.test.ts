import { describe, expect, test } from "bun:test";

import { capabilityCatalog } from "./capabilities.js";

describe("DocsMint MCP catalog contract", () => {
	test("publishes document manager, retrieval, graph, and indexing tools", () => {
		expect(capabilityCatalog.tools).toEqual(
			expect.arrayContaining([
				"create_document",
				"update_document",
				"list_documents",
				"list_categories",
				"create_category",
				"list_folders",
				"create_folder",
				"list_tags",
				"search_documents",
				"get_related_documents",
				"search_knowledge_graph",
				"get_document_index_status",
				"refresh_document_index",
			]),
		);
	});

	test("publishes prompts and resources for agent discovery", () => {
		expect(capabilityCatalog.prompts).toEqual([
			"organize_workspace",
			"research_workspace",
		]);
		expect(capabilityCatalog.resources).toEqual([
			"docsmint://guide/editor",
			"docsmint://guide/search",
			"docsmint://workspace/catalog",
		]);
	});

	test("ships the registry badge, three easy installs, license, and an agent skill", async () => {
		const root = new URL("../../../", import.meta.url);
		const readme = await Bun.file(new URL("README.md", root)).text();
		const mcpReadme = await Bun.file(
			new URL("packages/mcp-server/README.md", root),
		).text();
		const publishedPackage = await Bun.file(
			new URL("package.public.json", root),
		).json();
		const skill = Bun.file(
			new URL("skills/docsmint-document-manager/SKILL.md", root),
		);

		expect(readme).toContain(
			"lobehub.com/badge/mcp/hiai-gg-docsmint?style=plastic",
		);
		expect(mcpReadme).toContain("### Bunx");
		expect(mcpReadme).toContain("### NPX");
		expect(mcpReadme).toContain("### Local checkout");
		expect(await skill.exists()).toBe(true);
		expect(publishedPackage.files).toContain("skills");
		expect(await Bun.file(new URL("LICENSE", root)).text()).toContain(
			"Apache License",
		);
	});
});
