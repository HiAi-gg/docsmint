import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

type CommandResult = Readonly<{
	stdout: string;
	stderr: string;
	exitCode: number;
}>;

type ServiceEvidence = Readonly<{
	service: string;
	projectLabel: string;
	serviceLabel: string;
	status: string;
	health: string;
}>;

const root = resolve(import.meta.dir, "..");
const composePrefix = ["docker", "compose", "--env-file", "/dev/null"] as const;
const dependencyCommand = [
	...composePrefix,
	"up",
	"--detach",
	"--wait",
	"postgres",
	"redis",
	"seaweedfs",
] as const;
const migrationCommand = [
	...composePrefix,
	"run",
	"--rm",
	"--no-deps",
	"migrate",
] as const;
const applicationCommand = [
	...composePrefix,
	"up",
	"--detach",
	"--no-deps",
	"--wait",
	"api",
	"web",
] as const;
const requiredServices = ["postgres", "redis", "seaweedfs", "api", "web"] as const;
const sensitiveEnvironmentName =
	/(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|DATABASE_URL|REDIS_URL|CREDENTIAL)/i;

function requiredEnvironment(name: string): string {
	const value = Bun.env[name]?.trim();
	if (!value) throw new Error(`Release Docker smoke requires ${name}`);
	return value;
}

function secretValues(environment: Record<string, string | undefined>): string[] {
	return Object.entries(environment)
		.filter(([name, value]) => sensitiveEnvironmentName.test(name) && Boolean(value))
		.map(([, value]) => value as string)
		.filter((value) => value.length >= 4)
		.sort((left, right) => right.length - left.length);
}

function sanitizer(values: readonly string[]): (text: string) => string {
	return (text) => {
		let sanitized = text;
		for (const value of values) sanitized = sanitized.replaceAll(value, "[REDACTED]");
		return sanitized;
	};
}

async function execute(
	argv: readonly string[],
	environment: Record<string, string | undefined>,
	logs: string[],
	sanitize: (text: string) => string,
): Promise<CommandResult> {
	const child = Bun.spawn([...argv], {
		cwd: root,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	logs.push(
		[
			`$ ${argv.join(" ")}`,
			`[exit ${exitCode}]`,
			stdout ? `[stdout]\n${sanitize(stdout).trimEnd()}` : "[stdout]",
			stderr ? `[stderr]\n${sanitize(stderr).trimEnd()}` : "[stderr]",
		].join("\n"),
	);
	return { stdout, stderr, exitCode };
}

async function requireSuccess(
	argv: readonly string[],
	environment: Record<string, string | undefined>,
	logs: string[],
	sanitize: (text: string) => string,
): Promise<CommandResult> {
	const result = await execute(argv, environment, logs, sanitize);
	if (result.exitCode !== 0) {
		throw new Error(`${argv.join(" ")} failed with exit ${result.exitCode}`);
	}
	return result;
}

function nonemptyLines(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function migrateContainers(
	project: string,
	environment: Record<string, string | undefined>,
	logs: string[],
	sanitize: (text: string) => string,
): Promise<string[]> {
	const result = await requireSuccess(
		[
			"docker",
			"ps",
			"--all",
			"--quiet",
			"--filter",
			`label=com.docker.compose.project=${project}`,
			"--filter",
			"label=com.docker.compose.service=migrate",
		],
		environment,
		logs,
		sanitize,
	);
	return nonemptyLines(result.stdout);
}

async function inspectValue(
	containerId: string,
	format: string,
	environment: Record<string, string | undefined>,
	logs: string[],
	sanitize: (text: string) => string,
): Promise<unknown> {
	const result = await requireSuccess(
		["docker", "inspect", "--format", format, containerId],
		environment,
		logs,
		sanitize,
	);
	try {
		return JSON.parse(result.stdout.trim()) as unknown;
	} catch {
		throw new Error("Docker inspect returned malformed JSON");
	}
}

async function inspectService(
	service: (typeof requiredServices)[number],
	project: string,
	environment: Record<string, string | undefined>,
	logs: string[],
	sanitize: (text: string) => string,
): Promise<ServiceEvidence> {
	const result = await requireSuccess(
		[...composePrefix, "ps", "--all", "--quiet", service],
		environment,
		logs,
		sanitize,
	);
	const containerIds = nonemptyLines(result.stdout);
	if (containerIds.length !== 1) {
		throw new Error(`${service} must resolve to exactly one Compose container`);
	}
	const containerId = containerIds[0] as string;
	const labels = (await inspectValue(
		containerId,
		"{{json .Config.Labels}}",
		environment,
		logs,
		sanitize,
	)) as Record<string, unknown>;
	const status = await inspectValue(
		containerId,
		"{{json .State.Status}}",
		environment,
		logs,
		sanitize,
	);
	const health = await inspectValue(
		containerId,
		"{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}",
		environment,
		logs,
		sanitize,
	);
	const projectLabel = labels["com.docker.compose.project"];
	const serviceLabel = labels["com.docker.compose.service"];
	if (projectLabel !== project) {
		throw new Error(`${service} Compose project label mismatch`);
	}
	if (serviceLabel !== service) {
		throw new Error(`${service} Compose service label mismatch`);
	}
	if (status !== "running" || health !== "healthy") {
		throw new Error(`${service} must be running and healthy`);
	}
	return {
		service,
		projectLabel,
		serviceLabel: service,
		status: "running",
		health: "healthy",
	};
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

const environment = { ...Bun.env };
const expectedCommit = requiredEnvironment("RELEASE_COMMIT");
const composeProject = requiredEnvironment("COMPOSE_PROJECT_NAME");
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
	throw new Error("RELEASE_COMMIT must be a full lowercase Git commit SHA");
}
if (!/^[a-z0-9][a-z0-9_-]{2,62}$/.test(composeProject)) {
	throw new Error("COMPOSE_PROJECT_NAME must be an explicit isolated release project");
}

const evidenceDirectory = resolve(
	root,
	Bun.env.RELEASE_DOCKER_EVIDENCE_DIRECTORY ??
		"build/release-evidence/docker-smoke",
);
await mkdir(evidenceDirectory, { recursive: true });
const logs: string[] = [];
const sanitize = sanitizer(secretValues(environment));
let evidenceText: string | undefined;
let failure: Error | undefined;

try {
	const head = (
		await requireSuccess(["git", "rev-parse", "HEAD"], environment, logs, sanitize)
	).stdout.trim();
	if (head !== expectedCommit) {
		throw new Error(
			`Release Docker smoke commit mismatch: expected ${expectedCommit}, got ${head}`,
		);
	}

	await requireSuccess([...composePrefix, "config", "--quiet"], environment, logs, sanitize);
	const beforeMigration = await migrateContainers(
		composeProject,
		environment,
		logs,
		sanitize,
	);
	if (beforeMigration.length !== 0) {
		throw new Error("Release Compose project contains a stale migrate container");
	}
	await requireSuccess(dependencyCommand, environment, logs, sanitize);
	const migration = await execute(
		migrationCommand,
		environment,
		logs,
		sanitize,
	);
	if (migration.exitCode !== 0) {
		throw new Error(`Standalone Docker migration failed with exit ${migration.exitCode}`);
	}
	const afterMigration = await migrateContainers(
		composeProject,
		environment,
		logs,
		sanitize,
	);
	if (afterMigration.length !== 0) {
		throw new Error("Standalone migration did not remove its Compose container");
	}
	await requireSuccess(applicationCommand, environment, logs, sanitize);
	const afterApplicationStart = await migrateContainers(
		composeProject,
		environment,
		logs,
		sanitize,
	);
	if (afterApplicationStart.length !== 0) {
		throw new Error("Application startup recreated the Compose migrate service");
	}

	const services: ServiceEvidence[] = [];
	for (const service of requiredServices) {
		services.push(
			await inspectService(service, composeProject, environment, logs, sanitize),
		);
	}
	const evidence = {
		schemaVersion: 1,
		commit: head,
		composeProject,
		migration: {
			command: migrationCommand.join(" "),
			exitCode: migration.exitCode,
		},
		migrateContainers: {
			beforeMigration,
			afterMigration,
			afterApplicationStart,
		},
		services,
	};
	evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
} catch (error) {
	failure = error instanceof Error ? error : new Error(String(error));
}

const rawLog = `${logs.join("\n\n")}\n`;
await Bun.write(join(evidenceDirectory, "docker-smoke.log"), rawLog);
const checksums = [`${sha256(rawLog)}  docker-smoke.log`];
if (evidenceText) {
	await Bun.write(join(evidenceDirectory, "docker-smoke.json"), evidenceText);
	checksums.unshift(`${sha256(evidenceText)}  docker-smoke.json`);
}
await Bun.write(
	join(evidenceDirectory, "docker-smoke.sha256"),
	`${checksums.join("\n")}\n`,
);

if (failure) {
	console.error(sanitize(failure.message));
	process.exitCode = 1;
} else {
	console.log(
		`Release Docker smoke passed for ${expectedCommit}: migration exit 0, no recreate, five healthy labeled services`,
	);
}
