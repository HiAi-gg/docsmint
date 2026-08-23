import { expect, test } from "bun:test";

const workflow = await Bun.file(
	new URL("../../../.github/workflows/ci.yml", import.meta.url),
).text();

test("CI separates hermetic units from zero-skip database integrations", () => {
	expect(workflow).toContain("unit-test:");
	expect(workflow).toContain("integration-test:");
	expect(workflow).toContain("PIPELINE_RLS_TEST_DATABASE_URL:");
	expect(workflow).toContain("LIFECYCLE_TEST_DATABASE_URL:");
	for (const suite of [
		"pipeline tenant RLS integration",
		"lifecycle operation persistence integration",
		"re-embed delete parent-row lock integration",
		"embedding context migration integration",
	]) {
		expect(workflow).toContain(suite);
	}
	expect(workflow).toContain("Required integration suites: 4; skipped: 0");
});

test("CI smoke and vulnerability gates fail closed without repository env files", () => {
	expect(workflow).not.toContain("cp .env.example .env");
	expect(workflow).not.toMatch(/sed -i .*\.env/);
	expect(workflow).toContain(
		"docker compose --env-file /dev/null up --detach --no-build --wait api",
	);
	expect(workflow).toContain(
		"curl --fail --silent --show-error http://127.0.0.1:50700/api/health",
	);
	expect(workflow.match(/exit-code: '1'/g)).toHaveLength(2);
	expect(workflow.match(/severity: 'CRITICAL'/g)).toHaveLength(2);
});
