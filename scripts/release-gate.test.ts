import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releaseGate = await import("./release-gate.ts").catch(() => undefined);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
	);
});

async function temporaryRepository(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-release-gate-"));
	temporaryDirectories.push(directory);
	for (const args of [
		["init", "--quiet"],
		["config", "user.email", "release-test@example.com"],
		["config", "user.name", "Release Test"],
	]) {
		expect(Bun.spawnSync(["git", ...args], { cwd: directory }).exitCode).toBe(0);
	}
	await Bun.write(join(directory, "tracked.txt"), "committed\n");
	expect(Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: directory }).exitCode).toBe(0);
	expect(
		Bun.spawnSync(["git", "commit", "--quiet", "-m", "fixture"], { cwd: directory })
			.exitCode,
	).toBe(0);
	return directory;
}

test("canonical release gate implementation is executable", () => {
	expect(releaseGate).toBeDefined();
});

test("clean-state check rejects untracked and staged release candidates", async () => {
	if (!releaseGate) return;
	const root = await temporaryRepository();
	await expect(releaseGate.assertCleanRepository(root)).resolves.toBeUndefined();

	await Bun.write(join(root, "untracked.txt"), "untracked\n");
	await expect(releaseGate.assertCleanRepository(root)).rejects.toThrow(
		"Release candidate is not clean",
	);
	await rm(join(root, "untracked.txt"));

	await Bun.write(join(root, "tracked.txt"), "staged\n");
	expect(Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: root }).exitCode).toBe(0);
	await expect(releaseGate.assertCleanRepository(root)).rejects.toThrow(
		"Release candidate is not clean",
	);
});

test("canonical release gate coordinates static, live, package, Docker, and browser gates", () => {
	if (!releaseGate) return;
	const stepNames = releaseGate.releaseGateSteps("v0.7.0").map(
		(step: { name: string }) => step.name,
	);
	expect(stepNames).toEqual([
		"frozen install",
		"release version",
		"workflow contract",
		"production audit",
		"tracked secret scan",
		"contract evidence",
		"lint",
		"typecheck",
		"unit tests",
		"contract tests",
		"all workspace builds",
		"packed package",
		"clean installed consumer",
		"compose configuration",
		"container port contract",
		"fresh Docker rebuild",
		"commit-bound Docker lifecycle evidence",
		"Host adoption rehearsal",
		"required PostgreSQL integrations",
		"required live public surfaces",
		"service health contract",
		"Lightpanda desktop/mobile E2E",
	]);
});

test("Host rehearsal uses the freshly rebuilt release dependencies", () => {
	if (!releaseGate) return;
	const stepNames = releaseGate.releaseGateSteps("v0.7.0").map(
		(step: { name: string }) => step.name,
	);
	const rebuild = stepNames.indexOf("fresh Docker rebuild");
	const dependencyStart = stepNames.indexOf("commit-bound Docker lifecycle evidence");
	const rehearsal = stepNames.indexOf("Host adoption rehearsal");

	expect(rebuild).toBeGreaterThanOrEqual(0);
	expect(dependencyStart).toBeGreaterThan(rebuild);
	expect(rehearsal).toBeGreaterThan(dependencyStart);
});

test("Docker lifecycle is owned by the commit-bound evidence coordinator", () => {
	if (!releaseGate) return;
	const steps = releaseGate.releaseGateSteps("v0.7.0") as Array<{
		name: string;
		command: string[];
	}>;
	const lifecycle = steps.find(
		(step) => step.name === "commit-bound Docker lifecycle evidence",
	);
	expect(lifecycle?.command).toEqual([
		"bun",
		"run",
		"release:check:docker-smoke",
	]);
	const health = steps.find((step) => step.name === "service health contract");
	expect(health?.command).toEqual(["bash", "scripts/health-check.sh"]);
});

test("full Docker startup preserves the explicit production-safe public storage URL", () => {
	if (!releaseGate) return;
	const environmentForStep = (
		releaseGate as unknown as {
			environmentForStep?: (
				step: { name: string; command: readonly string[] },
				environment: Record<string, string | undefined>,
			) => Record<string, string | undefined>;
		}
	).environmentForStep;
	expect(typeof environmentForStep).toBe("function");
	if (!environmentForStep) return;

	const environment = environmentForStep(
		{ name: "commit-bound Docker lifecycle evidence", command: [] },
		{
			API_PORT: "51710",
			DOCSMINT_WORKSPACE_ENABLED: "true",
			STORAGE_PUBLIC_ENDPOINT_URL: "https://storage.release.invalid",
		},
	);
	expect(environment.STORAGE_PUBLIC_ENDPOINT_URL).toBe(
		"https://storage.release.invalid",
	);
	expect(environment.DOCSMINT_WORKSPACE_ENABLED).toBe("false");
});

test("live public surfaces bind every service to the isolated contract stack", () => {
	if (!releaseGate) return;
	const environmentForStep = (
		releaseGate as unknown as {
			environmentForStep?: (
				step: { name: string; command: readonly string[] },
				environment: Record<string, string | undefined>,
			) => Record<string, string | undefined>;
		}
	).environmentForStep;
	expect(typeof environmentForStep).toBe("function");
	if (!environmentForStep) return;

	const environment = environmentForStep(
		{ name: "required live public surfaces", command: [] },
		{
			DOCSMINT_CONTRACT_BASE_URL: "http://127.0.0.1:51710",
			DOCSMINT_CONTRACT_DATABASE_URL: "postgresql://hiai_app:runtime@127.0.0.1/test",
			DATABASE_URL: "postgresql://aiuser:admin@127.0.0.1/test",
			DOCSMINT_LIVE_API_PORT: "51710",
			DOCSMINT_CONTRACT_STORAGE_URL: "http://127.0.0.1:51702",
			STORAGE_INTERNAL_ENDPOINT_URL: "http://stale.invalid:8333",
			STORAGE_PUBLIC_ENDPOINT_URL: "https://storage.release.invalid",
		},
	);

	expect(environment.API_PORT).toBe("51710");
	expect(environment.DATABASE_URL).toBe(
		"postgresql://hiai_app:runtime@127.0.0.1/test",
	);
	expect(environment.BETTER_AUTH_URL).toBe("http://127.0.0.1:51710");
	expect(environment.STORAGE_INTERNAL_ENDPOINT_URL).toBe(
		"http://127.0.0.1:51702",
	);
	expect(environment.STORAGE_PUBLIC_ENDPOINT_URL).toBe(
		"http://127.0.0.1:51702",
	);
	expect(() =>
		environmentForStep(
			{ name: "required live public surfaces", command: [] },
			{
				DOCSMINT_CONTRACT_BASE_URL: "http://127.0.0.1:51710",
				DOCSMINT_LIVE_API_PORT: "51710",
			},
		),
	).toThrow("DOCSMINT_CONTRACT_DATABASE_URL");
});

test("PostgreSQL integration routes use the task admin URL for fixture-backed tests", () => {
	if (!releaseGate) return;
	const environmentForStep = (
		releaseGate as unknown as {
			environmentForStep?: (
				step: { name: string; command: readonly string[] },
				environment: Record<string, string | undefined>,
			) => Record<string, string | undefined>;
		}
	).environmentForStep;
	expect(typeof environmentForStep).toBe("function");
	if (!environmentForStep) return;

	const environment = environmentForStep(
		{ name: "required PostgreSQL integrations", command: [] },
		{
			DATABASE_URL: "postgresql://app_runtime@127.0.0.1/test",
			CONTENT_ACCESS_TEST_DATABASE_URL: "postgresql:///test",
		},
	);
	expect(environment.DATABASE_URL).toBe("postgresql:///test");
	expect(() =>
		environmentForStep(
			{ name: "required PostgreSQL integrations", command: [] },
			{ DATABASE_URL: "postgresql://stale.invalid/db" },
		),
	).toThrow("CONTENT_ACCESS_TEST_DATABASE_URL");
});

test("hermetic release phases cannot inherit live integration triggers", () => {
	if (!releaseGate) return;
	const environmentForStep = (
		releaseGate as unknown as {
			environmentForStep?: (
				step: { name: string; command: readonly string[] },
				environment: Record<string, string | undefined>,
			) => Record<string, string | undefined>;
		}
	).environmentForStep;
	expect(typeof environmentForStep).toBe("function");
	if (!environmentForStep) return;

	for (const name of ["unit tests", "contract tests"]) {
		const environment = environmentForStep(
			{ name, command: [] },
			{
				PIPELINE_RLS_TEST_DATABASE_URL: "postgresql://live.invalid/db",
				LIFECYCLE_TEST_DATABASE_URL: "postgresql://live.invalid/db",
				CONTENT_ACCESS_TEST_DATABASE_URL: "postgresql://live.invalid/db",
				DOCSMINT_CONTRACT_DATABASE_URL: "postgresql://live.invalid/db",
				CORS_ORIGINS: "http://127.0.0.1:51711",
				BETTER_AUTH_URL: "http://127.0.0.1:51710",
				API_PORT: "51710",
				PATH: "/test/bin",
			},
		);
		expect(environment.PIPELINE_RLS_TEST_DATABASE_URL).toBeUndefined();
		expect(environment.LIFECYCLE_TEST_DATABASE_URL).toBeUndefined();
		expect(environment.CONTENT_ACCESS_TEST_DATABASE_URL).toBeUndefined();
		expect(environment.DOCSMINT_CONTRACT_DATABASE_URL).toBeUndefined();
		expect(environment.CORS_ORIGINS).toBeUndefined();
		expect(environment.BETTER_AUTH_URL).toBeUndefined();
		expect(environment.API_PORT).toBeUndefined();
		expect(environment.PATH).toBe("/test/bin");
	}
});

test("release DB bindings constrain test targets and runtime roles", () => {
	if (!releaseGate) return;
	const validate = (
		releaseGate as unknown as {
			validateTestDatabaseBindings?: (
				environment: Record<string, string | undefined>,
			) => void;
		}
	).validateTestDatabaseBindings;
	expect(typeof validate).toBe("function");
	if (!validate) return;
	const safeEnvironment = {
		PGUSER: "vlgalib",
		DATABASE_URL: "postgresql:///app_docsmint_oss_release",
		PIPELINE_RLS_TEST_DATABASE_URL: "postgresql:///app_docsmint_oss_release",
		LIFECYCLE_TEST_DATABASE_URL: "postgresql:///app_docsmint_oss_release",
		CONTENT_ACCESS_TEST_DATABASE_URL: "postgresql:///app_docsmint_oss_release",
		DOCSMINT_CONTRACT_DATABASE_URL:
			"postgresql://app_docsmint_oss_release:runtime@127.0.0.1:5432/app_docsmint_oss_release",
	};
	expect(() => validate(safeEnvironment)).not.toThrow();
	const ciLiveEnvironment = {
		DATABASE_URL: "postgresql://hiai_app:runtime@127.0.0.1:5437/hiai_docs",
		DOCSMINT_CONTRACT_DATABASE_URL:
			"postgresql://hiai_app:runtime@127.0.0.1:5437/hiai_docs",
		PIPELINE_RLS_TEST_DATABASE_URL:
			"postgresql://aiuser:admin@127.0.0.1:5437/hiai_docs",
		LIFECYCLE_TEST_DATABASE_URL:
			"postgresql://aiuser:admin@127.0.0.1:5437/hiai_docs",
		CONTENT_ACCESS_TEST_DATABASE_URL:
			"postgresql://aiuser:admin@127.0.0.1:5437/hiai_docs",
	};
	expect(() => validate(ciLiveEnvironment)).not.toThrow();
	expect(() =>
		validate({
			...safeEnvironment,
			CONTENT_ACCESS_TEST_DATABASE_URL:
				"postgresql://aiuser:test@db.production.invalid:5432/app_docsmint_oss_release",
		}),
	).toThrow("loopback");
	expect(() =>
		validate({
			...safeEnvironment,
			CONTENT_ACCESS_TEST_DATABASE_URL:
				"postgresql://aiuser:test@127.0.0.1:5432/customer_prod",
		}),
	).toThrow("disposable");
	expect(() =>
		validate({
			...safeEnvironment,
			DOCSMINT_CONTRACT_DATABASE_URL:
				"postgresql://aiuser:test@127.0.0.1:5432/app_docsmint_oss_release",
		}),
	).toThrow("runtime role");
	expect(() =>
		validate({ ...safeEnvironment, PGHOST: "db.production.invalid" }),
	).toThrow("loopback");
	expect(() => validate({ ...safeEnvironment, PGPORT: "5439" })).toThrow(
		"local PostgreSQL test port",
	);
	expect(() =>
		validate({ ...safeEnvironment, PGUSERNAME: "customer_admin" }),
	).toThrow("allowlisted test role");
});

test("release gate output redacts PostgreSQL and Redis credentials", () => {
	if (!releaseGate) return;
	const redact = (
		releaseGate as unknown as { redactGateOutput?: (output: string) => string }
	).redactGateOutput;
	expect(typeof redact).toBe("function");
	if (!redact) return;
	expect(
		redact(
			"postgresql://fixture:secret@127.0.0.1/db redis://default:token@127.0.0.1/4",
		),
	).toBe("postgresql://[REDACTED]@127.0.0.1/db redis://[REDACTED]@127.0.0.1/4");
});
