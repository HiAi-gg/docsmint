import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ReleaseGateStep = Readonly<{
	name: string;
	command: readonly string[];
}>;

const requiredEnvironment = [
	"COMPOSE_PROJECT_NAME",
	"DB_PASSWORD",
	"HIAI_APP_PASSWORD",
	"BETTER_AUTH_SECRET",
	"CSRF_SECRET",
	"STORAGE_SECRET_KEY",
	"WEBHOOK_SECRET",
	"HIAI_DOCS_API_KEY",
	"API_KEY_ENCRYPTION_SECRET",
	"PIPELINE_RLS_TEST_DATABASE_URL",
	"LIFECYCLE_TEST_DATABASE_URL",
	"CONTENT_ACCESS_TEST_DATABASE_URL",
	"DOCSMINT_WORKSPACE_SECRET",
	"DOCSMINT_WORKSPACE_ISSUER",
	"DOCSMINT_CONTRACT_EMBEDDING_URL",
	"EMBEDDING_BASE_URL",
	"DOCSMINT_CONTRACT_DATABASE_URL",
	"DATABASE_URL",
	"DOCSMINT_CONTRACT_BASE_URL",
	"DOCSMINT_LIVE_API_PORT",
	"API_PORT",
	"DOCSMINT_CONTRACT_REDIS_URL",
	"REDIS_URL",
	"DOCSMINT_CONTRACT_STORAGE_URL",
	"STORAGE_INTERNAL_ENDPOINT_URL",
	"STORAGE_PUBLIC_ENDPOINT_URL",
] as const;

export function releaseGateSteps(tag: string): ReleaseGateStep[] {
	return [
		{ name: "frozen install", command: ["bun", "install", "--frozen-lockfile"] },
		{
			name: "release version",
			command: ["bun", "run", "scripts/release-version-validator.ts", tag],
		},
		{
			name: "workflow contract",
			command: ["bun", "run", "release:check:workflow"],
		},
		{
			name: "production audit",
			command: ["bun", "run", "release:check:audit"],
		},
		{
			name: "tracked secret scan",
			command: ["bun", "run", "release:check:secrets"],
		},
		{
			name: "contract evidence",
			command: ["bun", "run", "release:check:contract-evidence"],
		},
		{ name: "lint", command: ["bun", "run", "lint"] },
		{ name: "typecheck", command: ["bun", "run", "typecheck"] },
		{ name: "unit tests", command: ["bun", "run", "test:unit"] },
		{ name: "contract tests", command: ["bun", "run", "test:contract"] },
		{
			name: "all workspace builds",
			command: ["bun", "run", "--sequential", "--filter", "*", "build"],
		},
		{ name: "packed package", command: ["bun", "run", "test:package"] },
		{
			name: "clean installed consumer",
			command: ["bash", "scripts/test-public-package-consumer.sh"],
		},
		{
			name: "compose configuration",
			command: ["docker", "compose", "--env-file", "/dev/null", "config", "--quiet"],
		},
		{
			name: "container port contract",
			command: ["sh", "scripts/check-compose-port-contract.sh"],
		},
		{
			name: "fresh Docker rebuild",
			command: ["docker", "compose", "--env-file", "/dev/null", "build"],
		},
		{
			name: "commit-bound Docker lifecycle evidence",
			command: ["bun", "run", "release:check:docker-smoke"],
		},
		{
			name: "SaaS adoption rehearsal",
			command: ["bun", "run", "scripts/rehearse-saas-0.7-adoption.ts"],
		},
		{
			name: "required PostgreSQL integrations",
			command: ["bun", "run", "test:integration"],
		},
		{
			name: "required live public surfaces",
			command: ["bun", "run", "test:contract:scoped-live"],
		},
		{
			name: "service health contract",
			command: ["bash", "scripts/health-check.sh"],
		},
		{
			name: "Lightpanda desktop/mobile E2E",
			command: ["bun", "run", "release:check:browser"],
		},
	];
}

async function gitOutput(root: string, args: readonly string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args[0] ?? "command"} failed`);
	return stdout;
}

export async function assertCleanRepository(root: string): Promise<void> {
	const status = await gitOutput(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
	]);
	if (status.length > 0) {
		const entries = status.split("\0").filter(Boolean).length;
		throw new Error(
			`Release candidate is not clean: ${entries} staged, modified, or untracked entries`,
		);
	}
}

function requireEnvironment(): void {
	const missing = requiredEnvironment.filter((name) => !Bun.env[name]?.trim());
	if (missing.length > 0) {
		throw new Error(
			`Complete release gate requires explicit test-only environment values: ${missing.join(", ")}`,
		);
	}
	if (Bun.env.AGENT_BROWSER_ENGINE !== "lightpanda") {
		throw new Error("Complete release gate requires AGENT_BROWSER_ENGINE=lightpanda");
	}
}

async function runStep(
	root: string,
	step: ReleaseGateStep,
	environment: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
	console.log(`\n[release gate] ${step.name}: ${step.command.join(" ")}`);
	const startedAt = performance.now();
	const child = Bun.spawn([...step.command], {
		cwd: root,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPromise = (async () => {
		const output = await new Response(child.stdout).text();
		if (output) globalThis.process.stdout.write(output);
		return output;
	})();
	const stderrPromise = (async () => {
		const output = await new Response(child.stderr).text();
		if (output) globalThis.process.stderr.write(output);
		return output;
	})();
	const [stdout, stderr, exitCode] = await Promise.all([
		stdoutPromise,
		stderrPromise,
		child.exited,
	]);
	return {
		stdout,
		stderr,
		exitCode,
		durationMs: Math.round(performance.now() - startedAt),
	};
}

function logName(index: number, name: string): string {
	return `${String(index + 1).padStart(2, "0")}-${name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")}.log`;
}

const hermeticEnvironmentNames = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CI",
	"GITHUB_ACTIONS",
	"BUN_INSTALL",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
] as const;

export function environmentForStep(
	step: ReleaseGateStep,
	base: Record<string, string | undefined>,
): Record<string, string | undefined> {
	if (step.name === "unit tests" || step.name === "contract tests") {
		const hermetic: Record<string, string> = {};
		for (const name of hermeticEnvironmentNames) {
			const value = base[name];
			if (value) hermetic[name] = value;
		}
		return hermetic;
	}
	if (step.name === "required live public surfaces") {
		const contractStorageUrl = base.DOCSMINT_CONTRACT_STORAGE_URL;
		return {
			...base,
			// Keep the real Seaweed presign-expiry lifecycle regression bounded.
			// Production keeps the configured/default value; only the isolated
			// release contract stack uses the minimum accepted lifetime.
			ATTACHMENT_PRESIGN_EXPIRY_SECONDS: "60",
			API_PORT: base.DOCSMINT_LIVE_API_PORT,
			BETTER_AUTH_URL: base.DOCSMINT_CONTRACT_BASE_URL,
			STORAGE_INTERNAL_ENDPOINT_URL: contractStorageUrl,
			STORAGE_PUBLIC_ENDPOINT_URL: contractStorageUrl,
		};
	}
	if (step.name === "commit-bound Docker lifecycle evidence") {
		const apiPort = base.API_PORT ?? "50700";
		return {
			...base,
			BETTER_AUTH_URL: `http://127.0.0.1:${apiPort}`,
			DOCSMINT_WORKSPACE_ENABLED: "false",
			REDIS_URL: "redis://redis:6379",
			STORAGE_INTERNAL_ENDPOINT_URL: "http://seaweedfs:8333",
		};
	}
	return base;
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	await assertCleanRepository(root);
	requireEnvironment();
	const manifest = (await Bun.file(join(root, "package.public.json")).json()) as {
		version: string;
	};
	const tagArgument = Bun.argv.find((value) => value.startsWith("v"));
	const tag = tagArgument ?? `v${manifest.version}`;
	const commit = (await gitOutput(root, ["rev-parse", "HEAD"])).trim();
	const evidenceDirectory = join(root, "build", "release-evidence", "local-release-gate");
	await mkdir(evidenceDirectory, { recursive: true });
	const environment = {
		...Bun.env,
		COMPOSE_BAKE: "false",
		PGPASSWORD: Bun.env.DB_PASSWORD,
		RELEASE_COMMIT: commit,
		RELEASE_DOCKER_EVIDENCE_DIRECTORY:
			"build/release-evidence/local-release-gate/docker-smoke",
		RELEASE_EVIDENCE_DIRECTORY: "build/release-evidence/local-release-gate/browser",
	};
	const results: Array<Record<string, unknown>> = [];
	let failure: Error | undefined;
	const steps = releaseGateSteps(tag);
	for (const [index, step] of steps.entries()) {
		const result = await runStep(
			root,
			step,
			environmentForStep(step, environment),
		);
		const log = logName(index, step.name);
		await Bun.write(
			join(evidenceDirectory, log),
			`${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`,
		);
		results.push({
			name: step.name,
			command: step.command,
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			log,
		});
		if (result.exitCode !== 0) {
			failure = new Error(`${step.name} failed with exit ${result.exitCode}`);
			break;
		}
	}
	if (!failure) {
		await assertCleanRepository(root);
	}
	await Bun.write(
		join(evidenceDirectory, "release-gate.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				commit,
				tag,
				status: failure ? "failed" : "passed",
				steps: results,
			},
			null,
			2,
		)}\n`,
	);
	if (failure) throw failure;
	console.log(`Complete clean-state release gate passed for ${tag} at ${commit}`);
}
