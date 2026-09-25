import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateMcpCatalog } from "./validate-mcp-catalog";

const glamaSchema = "https://glama.ai/mcp/schemas/server.json";

async function copyCatalogFixture() {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-mcp-catalog-"));
	const root = Bun.pathToFileURL(`${directory}/`);
	for (const file of ["server.json", "package.public.json", "lhm.plugin.json", "glama.json"]) {
		await Bun.write(
			new URL(file, root),
			await Bun.file(new URL(`../${file}`, import.meta.url)).arrayBuffer(),
		);
	}
	return { directory, root };
}

test("accepts the committed MCP catalog manifests", async () => {
	await expect(validateMcpCatalog()).resolves.toBeUndefined();
});

test("rejects a Glama claim file without the GitHub repository maintainer", async () => {
	const { directory, root } = await copyCatalogFixture();
	try {
		await Bun.write(
			new URL("glama.json", root),
			`${JSON.stringify({ $schema: glamaSchema, maintainers: ["other-user"] })}\n`,
		);
		await expect(validateMcpCatalog(root)).rejects.toThrow(
			"glama.json must list the GitHub repository maintainer",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects an MCP Registry tool count that has drifted from the implementation", async () => {
	const { directory, root } = await copyCatalogFixture();
	try {
		const server = await Bun.file(new URL("server.json", root)).json();
		server._meta["io.modelcontextprotocol.registry/publisher-provided"].catalog.tools = 17;
		await Bun.write(new URL("server.json", root), `${JSON.stringify(server)}\n`);
		await expect(validateMcpCatalog(root)).rejects.toThrow(
			"server.json catalog tools must match the implementation",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
