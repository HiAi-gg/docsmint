import { expect, test } from "bun:test";

const workflow = await Bun.file(
	new URL("../../../.github/workflows/ci.yml", import.meta.url),
).text();

test("CI separates hermetic units from zero-skip database integrations", () => {
	expect(workflow).toContain("unit-test:");
	expect(workflow).toContain("integration-test:");
	expect(workflow).toContain("PIPELINE_RLS_TEST_DATABASE_URL:");
	expect(workflow).toContain("LIFECYCLE_TEST_DATABASE_URL:");
	expect(workflow).toContain("CONTENT_ACCESS_TEST_DATABASE_URL:");
	expect(workflow).toContain("DOCSMINT_CONTRACT_DATABASE_URL:");
	expect(workflow).toContain(
		"DATABASE_URL: postgresql://aiuser:testpassword@localhost:5432/hiai_docs_test",
	);
	expect(workflow).toContain("REDIS_URL: redis://127.0.0.1:6384/0");
	expect(workflow).toContain("docker run -d --name redis");
	for (const suite of [
		"pipeline tenant RLS integration",
		"lifecycle operation persistence integration",
		"re-embed delete parent-row lock integration",
		"embedding context migration integration",
		"recursive folder category resolution executes on PostgreSQL",
		"occupied replay keys distinguish authorized replay from a non-disclosing conflict",
		"authorizes grandparent-inherited category documents and excludes foreign graph IDs",
		"finds direct and two-level effective-category documents in owner and workspace tenants",
		"holds deterministic descendant locks through the document snapshot",
		"keeps concurrent observers isolated and preserves client ownership",
		"contains observer failures and never exposes query parameters",
		"does not install PostgreSQL debug instrumentation unless requested",
		"PUT write-hold keeps cleanup unclaimable until storage write activation",
		"workspace duplicate quota exhaustion rejects before copied attachments exist",
		"confirm lease blocks expired-upload cleanup from deleting the object",
		"account purge pages attachments beyond the cleanup batch size",
		"restore and hard purge serialize on the document pipeline lock without deadlock",
		"terminal quota rejection retires cleanup instead of retrying forever",
		"rejected-confirm exact drain ignores a backlog larger than one page",
		"account purge and attachment mutation serialize without deadlock",
	]) {
		expect(workflow).toContain(suite);
	}
	expect(workflow).toContain(
		"Required integration behavior cases: 26; skipped: 0",
	);
});

test("CI smoke and vulnerability gates fail closed without repository env files", () => {
	expect(workflow).not.toContain("cp .env.example .env");
	expect(workflow).not.toMatch(/sed -i .*\.env/);
	expect(workflow).toContain("bun run release:check:docker-smoke");
	expect(workflow).toContain(
		"curl --fail --silent --show-error http://127.0.0.1:50700/api/health",
	);
	expect(workflow.match(/exit-code: '1'/g)).toHaveLength(2);
	expect(workflow.match(/severity: 'CRITICAL'/g)).toHaveLength(2);
});

test("every release publication path validates committed version metadata", async () => {
	const manualRegistryWorkflow = await Bun.file(
		new URL("../../../.github/workflows/publish-mcp-registry.yml", import.meta.url),
	).text();
	const releaseHelper = await Bun.file(
		new URL("../../../scripts/release.sh", import.meta.url),
	).text();
	const validator = "bun run scripts/release-version-validator.ts";

	expect(workflow.match(new RegExp(validator, "g"))).toHaveLength(4);
	expect(manualRegistryWorkflow).toContain(validator);
	expect(manualRegistryWorkflow).toContain(
		"bun run scripts/verify-published-package.ts",
	);
	expect(manualRegistryWorkflow).toContain(
		"bun run scripts/validate-mcp-catalog.ts",
	);
	expect(manualRegistryWorkflow).toContain(
		'test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$RELEASE_COMMIT"',
	);
	expect(releaseHelper).toContain("scripts/release-version-validator.ts");
	expect(workflow).not.toContain("PUBLIC_DEPLOYMENT_ID=${{ github.ref_name }}");
	expect(workflow).not.toContain("pkg.version = '${CLEAN_VERSION}'");
});

test("tagged web publication receives the validated canonical PWA identity", async () => {
	const vite = await Bun.file(
		new URL("../../../frontend/vite.config.ts", import.meta.url),
	).text();
	const compose = await Bun.file(
		new URL("../../../docker-compose.yml", import.meta.url),
	).text();
	const validator = await Bun.file(
		new URL("../../../scripts/release-version-validator.ts", import.meta.url),
	).text();
	const canonicalDeploymentId = "docsmint-oss-0.8.1";

	expect(vite).toContain(canonicalDeploymentId);
	expect(compose).toContain(`PUBLIC_DEPLOYMENT_ID:-${canonicalDeploymentId}`);
	expect(workflow).toContain("PUBLIC_APP_ID=docsmint");
	expect(workflow).toContain(`PUBLIC_DEPLOYMENT_ID=${canonicalDeploymentId}`);
	expect(workflow).not.toContain("PUBLIC_DEPLOYMENT_ID=${{ github.ref_name }}");
	expect(validator).toContain("tagged web PWA identity");
	expect(validator).toContain("name: Rebuild and push Web image");
});
