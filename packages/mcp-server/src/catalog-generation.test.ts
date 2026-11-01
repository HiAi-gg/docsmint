import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { generateDocsmintMcpCatalog } from "./catalog.js";
import { capabilityCatalog } from "./capabilities.js";

test("documentation catalog discovers the real MCP inventory and valid branch examples without storage", async () => {
	const catalog = await generateDocsmintMcpCatalog();
	const manifest = (await Bun.file(
		new URL("../../../package.json", import.meta.url),
	).json()) as { version: string };
	expect(catalog.server).toEqual({
		name: "docsmint",
		version: manifest.version,
	});
	expect(catalog.tools.map((tool) => tool.name)).toEqual([
		...capabilityCatalog.tools,
	]);
	expect(catalog.prompts.map((prompt) => prompt.name)).toEqual([
		...capabilityCatalog.prompts,
	]);
	expect(catalog.resources.map((resource) => resource.uri)).toEqual([
		...capabilityCatalog.resources,
	]);
	const ajv = new Ajv2020({ strict: false, validateFormats: false });
	for (const tool of catalog.tools) {
		expect(tool.outputSchema, tool.name).toBeDefined();
		const validate = ajv.compile(tool.inputSchema);
		for (const input of tool.examples)
			expect(
				validate(input),
				`${tool.name}: ${JSON.stringify(validate.errors)}`,
			).toBe(true);
	}
	expect(await generateDocsmintMcpCatalog()).toEqual(catalog);
});
