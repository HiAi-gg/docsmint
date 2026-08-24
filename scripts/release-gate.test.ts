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
		"Docker dependency start",
		"Docker migrations",
		"SaaS adoption rehearsal",
		"required PostgreSQL integrations",
		"required live public surfaces",
		"Docker start and health",
		"service health contract",
		"Lightpanda desktop/mobile E2E",
	]);
});

test("SaaS rehearsal uses the freshly rebuilt release dependencies", () => {
	if (!releaseGate) return;
	const stepNames = releaseGate.releaseGateSteps("v0.7.0").map(
		(step: { name: string }) => step.name,
	);
	const rebuild = stepNames.indexOf("fresh Docker rebuild");
	const dependencyStart = stepNames.indexOf("Docker dependency start");
	const rehearsal = stepNames.indexOf("SaaS adoption rehearsal");

	expect(rebuild).toBeGreaterThanOrEqual(0);
	expect(dependencyStart).toBeGreaterThan(rebuild);
	expect(rehearsal).toBeGreaterThan(dependencyStart);
});

test("Docker lifecycle separates healthy services from one-shot migrations", () => {
	if (!releaseGate) return;
	const steps = releaseGate.releaseGateSteps("v0.7.0") as Array<{
		name: string;
		command: string[];
	}>;
	const dependencies = steps.find(
		(step) => step.name === "Docker dependency start",
	);
	const migrations = steps.find((step) => step.name === "Docker migrations");
	const fullStart = steps.find((step) => step.name === "Docker start and health");

	expect(dependencies?.command).toEqual([
		"docker",
		"compose",
		"--env-file",
		"/dev/null",
		"up",
		"--detach",
		"--wait",
		"postgres",
		"redis",
		"seaweedfs",
	]);
	expect(migrations?.command).toEqual([
		"docker",
		"compose",
		"--env-file",
		"/dev/null",
		"run",
		"--rm",
		"--no-deps",
		"migrate",
	]);
	expect(fullStart?.command.at(-2)).toBe("api");
	expect(fullStart?.command.at(-1)).toBe("web");
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
		{ name: "Docker start and health", command: [] },
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
			DOCSMINT_LIVE_API_PORT: "51710",
			DOCSMINT_CONTRACT_STORAGE_URL: "http://127.0.0.1:51702",
			STORAGE_INTERNAL_ENDPOINT_URL: "http://stale.invalid:8333",
			STORAGE_PUBLIC_ENDPOINT_URL: "https://storage.release.invalid",
		},
	);

	expect(environment.API_PORT).toBe("51710");
	expect(environment.BETTER_AUTH_URL).toBe("http://127.0.0.1:51710");
	expect(environment.STORAGE_INTERNAL_ENDPOINT_URL).toBe(
		"http://127.0.0.1:51702",
	);
	expect(environment.STORAGE_PUBLIC_ENDPOINT_URL).toBe(
		"http://127.0.0.1:51702",
	);
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
