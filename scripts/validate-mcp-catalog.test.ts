import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateMcpCatalog } from "./validate-mcp-catalog";

const glamaSchema = "https://glama.ai/mcp/schemas/connector.json";

test("accepts the committed MCP catalog manifests", async () => {
	await expect(validateMcpCatalog()).resolves.toBeUndefined();
});

test("rejects a Glama claim file without the public maintainer contact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-mcp-catalog-"));
	try {
		const root = Bun.pathToFileURL(`${directory}/`);
		await Bun.write(
			new URL("server.json", root),
			await Bun.file(new URL("../server.json", import.meta.url)).arrayBuffer(),
		);
		await Bun.write(
			new URL("package.public.json", root),
			await Bun.file(new URL("../package.public.json", import.meta.url)).arrayBuffer(),
		);
		await Bun.write(
			new URL("lhm.plugin.json", root),
			await Bun.file(new URL("../lhm.plugin.json", import.meta.url)).arrayBuffer(),
		);
		await Bun.write(
			new URL("glama.json", root),
			`${JSON.stringify({ $schema: glamaSchema, maintainers: [{ email: "other@example.com" }] })}\n`,
		);
		await expect(validateMcpCatalog(root)).rejects.toThrow(
			"glama.json must list the public maintainer contact",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
