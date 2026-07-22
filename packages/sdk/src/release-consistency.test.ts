import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../../../", import.meta.url);
const releaseVersion = "0.4.8";

async function json(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(new URL(path, repositoryRoot), "utf8"));
}

test("all published and workspace release metadata reports 0.4.8", async () => {
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
	expect(workspaceBlock.match(/"version": "0\.4\.7"/g)).toHaveLength(6);

	const publicManifest = await json("package.public.json");
	expect(publicManifest.name).toBe("@hiai-gg/docsmint");
	const publicExports = publicManifest.exports as Record<
		string,
		Record<string, string>
	>;
	expect(publicExports["./backend/launcher"]).toEqual({
		browser: "./dist/server-only-browser-entry.js",
		import: "./dist/backend-launcher.js",
		types: "./dist/backend-launcher.d.ts",
	});
	expect(publicExports["./storage-quota"]).toEqual({
		browser: "./dist/server-only-browser-entry.js",
		import: "./dist/storage-quota.js",
		types: "./dist/storage-quota.d.ts",
	});
	expect(publicExports["./backend/lib/api-key-facade"]).toEqual({
		import: "./backend/src/lib/api-key-facade.ts",
		types: "./backend/src/lib/api-key-facade.ts",
	});
	expect(publicExports["./lifecycle/runtime"]).toEqual({
		browser: "./dist/server-only-browser-entry.js",
		import: "./dist/lifecycle-runtime.js",
		types: "./dist/lifecycle-runtime.d.ts",
	});
	expect(publicExports["./pipeline/cancellation"]).toEqual({
		browser: "./dist/server-only-browser-entry.js",
		import: "./dist/pipeline-cancellation.js",
		types: "./dist/pipeline-cancellation.d.ts",
	});
	expect(publicExports["./backend/account-runtime-cleanup"]).toEqual({
		browser: "./dist/server-only-browser-entry.js",
		import: "./dist/backend-account-runtime-cleanup.js",
		types: "./dist/backend-account-runtime-cleanup.d.ts",
	});
	expect((publicManifest.dependencies as Record<string, string>).ioredis).toBe(
		"^5.11.1",
	);
	expect(publicExports["./frontend/styles.css"]).toBe(
		"./dist/frontend/frontend.css",
	);
	const appShellDeclarationWriter = await readFile(
		new URL(
			"packages/sdk/scripts/write-frontend-declarations.ts",
			repositoryRoot,
		),
		"utf8",
	);
	expect(appShellDeclarationWriter).toContain("DocsmintRequestAdapter");
	expect(appShellDeclarationWriter).toContain(
		"options?: DocsmintNavigationOptions",
	);
	const openApi = await json("docs/openapi.json");
	expect((openApi.info as { version: string }).version).toBe(releaseVersion);

	for (const path of [
		"backend/src/index.ts",
		"packages/cli/src/index.ts",
		"packages/mcp-server/src/index.ts",
	]) {
		expect(
			await readFile(new URL(path, repositoryRoot), "utf8"),
			path,
		).toContain(releaseVersion);
	}
});
