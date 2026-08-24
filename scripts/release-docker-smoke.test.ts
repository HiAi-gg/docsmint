import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];
const releaseCommit = "50ad607f10f336af6ef42f6e4d73344321e2b818";
const composeProject = "docsmint-release-round3-test";

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
	);
});

const fakeGit = `#!/usr/bin/env bun
if (Bun.argv.slice(2).join(" ") !== "rev-parse HEAD") process.exit(90);
console.log(Bun.env.FAKE_GIT_HEAD ?? "");
`;

const fakeDocker = `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
const statePath = Bun.env.FAKE_DOCKER_STATE;
if (!statePath) process.exit(91);
const existing = await Bun.file(statePath).json().catch(() => ({ calls: [], appsStarted: false }));
existing.calls.push(args);
const save = async () => Bun.write(statePath, JSON.stringify(existing));
const project = Bun.env.COMPOSE_PROJECT_NAME ?? "";
const command = args.join(" ");
if (command === "compose --env-file /dev/null config --quiet") {
  await save();
  process.exit(0);
}
if (command === "compose --env-file /dev/null up --detach --wait postgres redis seaweedfs") {
  await save();
  console.log("dependencies healthy");
  process.exit(0);
}
if (command === "compose --env-file /dev/null run --rm --no-deps migrate") {
  await save();
  console.log("migration used " + (Bun.env.DB_PASSWORD ?? "missing"));
  process.exit(Number(Bun.env.FAKE_MIGRATE_EXIT ?? "0"));
}
if (command === "compose --env-file /dev/null up --detach --no-deps --wait api web") {
  existing.appsStarted = true;
  await save();
  console.log("applications healthy");
  process.exit(0);
}
if (args[0] === "ps") {
  await save();
  if (existing.appsStarted && Bun.env.FAKE_RECREATE_MIGRATE === "1") console.log("migrate-recreated-id");
  process.exit(0);
}
if (args.slice(0, 6).join(" ") === "compose --env-file /dev/null ps --all --quiet") {
  await save();
  console.log((args.at(-1) ?? "missing") + "-id");
  process.exit(0);
}
if (args[0] === "inspect") {
  const service = (args.at(-1) ?? "").replace(/-id$/, "");
  const badService = Bun.env.FAKE_BAD_SERVICE;
  const badMode = Bun.env.FAKE_BAD_MODE;
  const labels = {
    "com.docker.compose.project": badService === service && badMode === "project-label" ? "spoofed-project" : project,
    "com.docker.compose.service": badService === service && badMode === "service-label" ? "spoofed-service" : service,
  };
  const health = badService === service && badMode === "health" ? "unhealthy" : "healthy";
  await save();
  if (args[2] === "{{json .Config.Labels}}") console.log(JSON.stringify(labels));
  else if (args[2] === "{{json .State.Status}}") console.log(JSON.stringify("running"));
  else if (args[2] === "{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}") console.log(JSON.stringify(health));
  else process.exit(93);
  process.exit(0);
}
await save();
console.error("unexpected fake docker command: " + command);
process.exit(92);
`;

async function runSmoke(
	overrides: Record<string, string> = {},
): Promise<{
	directory: string;
	evidenceDirectory: string;
	statePath: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-docker-smoke-test-"));
	temporaryDirectories.push(directory);
	const bin = join(directory, "bin");
	const evidenceDirectory = join(directory, "evidence");
	const statePath = join(directory, "docker-state.json");
	await mkdir(bin, { recursive: true });
	await Bun.write(join(bin, "git"), fakeGit);
	await Bun.write(join(bin, "docker"), fakeDocker);
	await Promise.all([chmod(join(bin, "git"), 0o755), chmod(join(bin, "docker"), 0o755)]);

	const child = Bun.spawn(
		[Bun.which("bun") ?? "bun", "run", "scripts/release-docker-smoke.ts"],
		{
			cwd: root,
			env: {
				...Bun.env,
				PATH: `${bin}:${Bun.env.PATH ?? ""}`,
				RELEASE_COMMIT: releaseCommit,
				COMPOSE_PROJECT_NAME: composeProject,
				RELEASE_DOCKER_EVIDENCE_DIRECTORY: evidenceDirectory,
				FAKE_GIT_HEAD: releaseCommit,
				FAKE_DOCKER_STATE: statePath,
				DB_PASSWORD: "round3-secret-database-password",
				...overrides,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { directory, evidenceDirectory, statePath, stdout, stderr, exitCode };
}

test("Docker smoke evidence is derived from the exact Git and Compose lifecycle", async () => {
	const result = await runSmoke();

	expect(result.exitCode).toBe(0);
	const evidenceText = await Bun.file(
		join(result.evidenceDirectory, "docker-smoke.json"),
	).text();
	const evidence = JSON.parse(evidenceText) as Record<string, unknown>;
	expect(evidence.commit).toBe(releaseCommit);
	expect(evidence.composeProject).toBe(composeProject);
	expect(evidence.migration).toEqual({
		command: "docker compose --env-file /dev/null run --rm --no-deps migrate",
		exitCode: 0,
	});
	expect(evidence.migrateContainers).toEqual({
		beforeMigration: [],
		afterMigration: [],
		afterApplicationStart: [],
	});
	expect(evidence.services).toEqual(
		["postgres", "redis", "seaweedfs", "api", "web"].map((service) => ({
			service,
			projectLabel: composeProject,
			serviceLabel: service,
			status: "running",
			health: "healthy",
		})),
	);

	const rawLog = await Bun.file(
		join(result.evidenceDirectory, "docker-smoke.log"),
	).text();
	expect(rawLog).not.toContain("round3-secret-database-password");
	expect(rawLog).toContain("[REDACTED]");
	const checksumManifest = await Bun.file(
		join(result.evidenceDirectory, "docker-smoke.sha256"),
	).text();
	expect(checksumManifest).toContain(
		`${createHash("sha256").update(evidenceText).digest("hex")}  docker-smoke.json`,
	);
	expect(checksumManifest).toContain(
		`${createHash("sha256").update(rawLog).digest("hex")}  docker-smoke.log`,
	);
});

test("Docker smoke fails before Docker when RELEASE_COMMIT does not match HEAD", async () => {
	const result = await runSmoke({ FAKE_GIT_HEAD: "0".repeat(40) });

	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain("Release Docker smoke commit mismatch");
	expect(await Bun.file(result.statePath).exists()).toBe(false);
});

test("Docker smoke fails closed on a non-zero standalone migration", async () => {
	const result = await runSmoke({ FAKE_MIGRATE_EXIT: "23" });

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("Standalone Docker migration failed with exit 23");
	const state = (await Bun.file(result.statePath).json()) as {
		calls: string[][];
	};
	expect(state.calls).not.toContainEqual([
		"compose",
		"--env-file",
		"/dev/null",
		"up",
		"--detach",
		"--no-deps",
		"--wait",
		"api",
		"web",
	]);
});

test("Docker smoke rejects a migrate container recreated by application startup", async () => {
	const result = await runSmoke({ FAKE_RECREATE_MIGRATE: "1" });

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain(
		"Application startup recreated the Compose migrate service",
	);
});

test("Docker smoke rejects incorrect Compose labels and unhealthy services", async () => {
	for (const [mode, message] of [
		["project-label", "web Compose project label mismatch"],
		["service-label", "web Compose service label mismatch"],
		["health", "web must be running and healthy"],
	] as const) {
		const result = await runSmoke({ FAKE_BAD_SERVICE: "web", FAKE_BAD_MODE: mode });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(message);
	}
});
