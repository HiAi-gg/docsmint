import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../../../", import.meta.url);
const releaseVersion = "0.3.3";

async function json(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(new URL(path, repositoryRoot), "utf8"));
}

test("all published and workspace release metadata reports 0.3.3", async () => {
	for (const path of [
		"package.public.json",
		"backend/package.json",
		"frontend/package.json",
		"packages/cli/package.json",
		"packages/db/package.json",
		"packages/mcp-server/package.json",
		"packages/sdk/package.json",
	]) {
		expect((await json(path)).version, path).toBe(releaseVersion);
	}

	const lockfile = await readFile(new URL("bun.lock", repositoryRoot), "utf8");
	const workspaceBlock = lockfile.slice(0, lockfile.indexOf('  "packages": {'));
	expect(workspaceBlock).not.toContain('"version": "0.3.0"');
	expect(workspaceBlock.match(/"version": "0\.3\.3"/g)).toHaveLength(6);

	const publicManifest = await json("package.public.json");
	expect(publicManifest.name).toBe("@hiai-gg/docsmint");
	const openApi = await json("docs/openapi.json");
	expect((openApi.info as { version: string }).version).toBe(releaseVersion);

	for (const path of [
		"backend/src/index.ts",
		"packages/cli/src/index.ts",
		"packages/mcp-server/src/index.ts",
	]) {
		expect(await readFile(new URL(path, repositoryRoot), "utf8"), path).toContain(
			releaseVersion,
		);
	}
});
