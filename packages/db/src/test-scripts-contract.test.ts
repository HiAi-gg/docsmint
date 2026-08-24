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
	expect(root["test:unit"]).toBe(
		"bun test --path-ignore-patterns='*node_modules*' scripts/*.test.ts && bun run --filter '*' test:unit",
	);
	expect(root["test:contract"]).toBe("bun run --filter '*' test:contract");
	expect(root.typecheck).toBe(
		"bun run typecheck:scripts && bun run --filter '*' typecheck",
	);
	expect(root["typecheck:scripts"]).toContain("scripts/release-gate.ts");
	expect(root["test:integration"]).toBe(
		[
			"bun run --filter '@hiai-docs/db' test:integration &&",
			"bun --no-env-file test --path-ignore-patterns='*node_modules*'",
			"backend/src/__tests__/content-access-postgres.integration.test.ts",
			"backend/src/__tests__/metadata-impact-postgres.integration.test.ts",
			"backend/src/__tests__/graph-routes.test.ts",
			"packages/db/scripts/query-observer.integration.test.ts",
		].join(" "),
	);
});

test("the canonical local release gate coordinates the complete clean-state release", async () => {
	const root = await scripts("package.json");

	expect(root["release:check:audit"]).toBe("bun audit --production");
	expect(root["release:check:secrets"]).toBe("bun run scripts/secret-scan.ts");
	expect(root["release:check:workflow"]).toBe(
		"bun run scripts/release-workflow-contract.ts",
	);
	expect(root["test:release"]).toBe("bun run scripts/release-gate.ts");
});

test("the clean public-package consumer uses Bun for packing and installation", async () => {
	const consumerScript = await readFile(
		new URL("scripts/test-public-package-consumer.sh", repositoryRoot),
		"utf8",
	);

	expect(consumerScript).toContain("bun pm pack");
	expect(consumerScript).toContain("bun add --ignore-scripts");
	expect(consumerScript).toContain("public-package-consumer.ts");
	expect(consumerScript).toContain("typescript/bin/tsc");
	expect(consumerScript).toContain("@hiai-docs/");
	expect(consumerScript).not.toContain("npm pack");
	expect(consumerScript).not.toContain("npm install");
	expect(consumerScript).not.toContain("node -e");
});
