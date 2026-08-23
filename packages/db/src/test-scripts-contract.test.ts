import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const repositoryRoot = new URL("../../../", import.meta.url);

async function scripts(path: string): Promise<Record<string, string>> {
	const manifest = JSON.parse(
		await readFile(new URL(path, repositoryRoot), "utf8"),
	) as { scripts: Record<string, string> };
	return manifest.scripts;
}

test("unit, contract, and required integration discovery stay explicit", async () => {
	const root = await scripts("package.json");
	const backend = await scripts("backend/package.json");
	const database = await scripts("packages/db/package.json");

	expect(backend["test:unit"]).toBe(
		"bun --no-env-file run scripts/run-hermetic-tests.ts src",
	);
	expect(backend["test:contract"]).toBe(
		"bun --no-env-file run scripts/run-hermetic-tests.ts tests/integration",
	);
	expect(database["test:unit"]).toBe(
		"bun --no-env-file test --path-ignore-patterns='*node_modules*' ./src/*.test.ts",
	);
	expect(database["test:contract"]).toBe(
		"bun --no-env-file test --path-ignore-patterns='*node_modules*' scripts/migrate.test.ts scripts/migration-owner-sql.test.ts",
	);
	expect(database["test:integration"]).toBe(
		[
			"bun --no-env-file test --path-ignore-patterns='*node_modules*'",
			"scripts/pipeline-rls.integration.test.ts",
			"scripts/lifecycle-operations.integration.test.ts",
			"scripts/reembed-delete-lock.integration.test.ts",
			"scripts/embedding-context-migration.integration.test.ts",
		].join(" "),
	);
	expect(root["test:unit"]).toBe("bun run --filter '*' test:unit");
	expect(root["test:contract"]).toBe("bun run --filter '*' test:contract");
	expect(root["test:integration"]).toBe(
		"bun run --filter '@hiai-docs/db' test:integration",
	);
});
