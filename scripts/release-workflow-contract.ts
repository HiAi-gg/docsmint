type WorkflowStep = Readonly<{ run?: string; uses?: string }>;
type WorkflowJob = Readonly<{
	env?: Readonly<Record<string, unknown>>;
	if?: string;
	needs?: string | string[];
	steps?: WorkflowStep[];
}>;

type Workflow = Readonly<{
	jobs?: Record<string, WorkflowJob>;
}>;

const completeGateJob = "release-tag-gate";
const publicationJobs = [
	"publish-docker",
	"publish-npm",
	"publish-mcp-registry",
	"create-github-release",
] as const;
const completeGateDependencies = [
	"lint",
	"typecheck",
	"unit-test",
	"integration-test",
	"scoped-live-integration",
	"build",
	"package-consumer",
	"docker-build",
	"browser-e2e",
	"release-static-gates",
] as const;
const liveDockerJobs = [
	"docker-build",
	"scoped-live-integration",
	"browser-e2e",
] as const;
const productionDockerJobs = ["docker-build", "browser-e2e"] as const;
const dependencyStartCommand =
	"docker compose --env-file /dev/null up --detach --wait postgres redis seaweedfs";
const migrateCommand =
	"docker compose --env-file /dev/null run --rm --no-deps migrate";
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const applicationStartCommands = {
	"docker-build":
		"docker compose --env-file /dev/null up --detach --no-build --wait api",
	"browser-e2e":
		"docker compose --env-file /dev/null up --detach --wait api web",
} as const;
const requiredCommands: Readonly<Record<string, readonly string[]>> = {
	lint: ["bun run lint"],
	typecheck: ["bun run typecheck"],
	"unit-test": ["bun run test:unit", "bun run test:contract"],
	"integration-test": ["bun run test:integration"],
	"scoped-live-integration": ["bun run test:contract:scoped-live"],
	build: ["bun run --sequential --filter '*' build"],
	"package-consumer": [
		"bun run scripts/verify-packed-package.ts",
		"bash scripts/test-public-package-consumer.sh",
	],
	"docker-build": [
		"docker compose --env-file /dev/null config --quiet",
		"sh scripts/check-compose-port-contract.sh",
	],
	"browser-e2e": ["bun run release:check:browser"],
	"release-static-gates": [
		"bun run release:check:clean",
		"bun install --frozen-lockfile",
		"bun run release:check:audit",
		"bun run release:check:secrets",
		'bun run scripts/release-version-validator.ts "${{ github.ref_name }}"',
		"bun run release:check:workflow",
		"bun run release:check:contract-evidence",
	],
	"release-tag-gate": ["bun run release:write:gate-result"],
};

function needs(job: WorkflowJob): string[] {
	if (Array.isArray(job.needs)) return job.needs;
	return job.needs ? [job.needs] : [];
}

function jobCommands(job: WorkflowJob): string[] {
	return (job.steps ?? [])
		.map((step) => step.run?.trim())
		.filter((command): command is string => Boolean(command));
}

function jobCommandLines(job: WorkflowJob): string[] {
	return jobCommands(job).flatMap((script) =>
		script
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
}

function isComposeUpWait(line: string): boolean {
	const tokens = line.split(/\s+/);
	return (
		tokens[0] === "docker" &&
		tokens[1] === "compose" &&
		tokens.includes("up") &&
		tokens.includes("--wait")
	);
}

function validateDockerLifecycle(jobs: Record<string, WorkflowJob>): void {
	for (const [name, job] of Object.entries(jobs)) {
		for (const line of jobCommandLines(job).filter(isComposeUpWait)) {
			const tokens = line.split(/\s+/);
			if (tokens.includes("migrate")) {
				throw new Error(
					`${name} must not run migrate through docker compose up --wait`,
				);
			}
			if (liveDockerJobs.includes(name as (typeof liveDockerJobs)[number])) {
				const upIndex = tokens.indexOf("up");
				const services = tokens
					.slice(upIndex + 1)
					.filter((token) => !token.startsWith("--"));
				if (services.length === 0) {
					throw new Error(
						`${name} must explicitly start only long-running dependencies before migrate`,
					);
				}
			}
		}
	}

	for (const name of liveDockerJobs) {
		const job = jobs[name];
		if (!job) throw new Error(`Release workflow is missing ${name}`);
		const lines = jobCommandLines(job);
		const dependencies = lines.indexOf(dependencyStartCommand);
		const migrate = lines.indexOf(migrateCommand);
		if (migrate < 0) {
			throw new Error(`${name} must run ${migrateCommand}`);
		}
		if (dependencies < 0 || dependencies > migrate) {
			throw new Error(
				`${name} must start long-running dependencies before standalone migrate`,
			);
		}
	}

	for (const [name, command] of Object.entries(applicationStartCommands)) {
		const lines = jobCommandLines(jobs[name] as WorkflowJob);
		const migrate = lines.indexOf(migrateCommand);
		const applicationStart = lines.indexOf(command);
		if (applicationStart < 0 || applicationStart < migrate) {
			const services = name === "browser-e2e" ? "API and web" : "API";
			throw new Error(
				`${name} must start ${services} after standalone migrate`,
			);
		}
	}
}

function validateStorageEndpoints(jobs: Record<string, WorkflowJob>): void {
	for (const name of productionDockerJobs) {
		const job = jobs[name];
		if (!job) throw new Error(`Release workflow is missing ${name}`);
		const publicUrl = job.env?.STORAGE_PUBLIC_ENDPOINT_URL;
		if (typeof publicUrl !== "string" || !publicUrl.startsWith("https://")) {
			throw new Error(
				`${name} must set STORAGE_PUBLIC_ENDPOINT_URL to an explicit HTTPS URL`,
			);
		}
		if (job.env?.STORAGE_INTERNAL_ENDPOINT_URL !== "http://seaweedfs:8333") {
			throw new Error(
				`${name} must keep STORAGE_INTERNAL_ENDPOINT_URL on http://seaweedfs:8333`,
			);
		}
		const ownerId = job.env?.OWNER_ID;
		if (typeof ownerId !== "string" || !uuidPattern.test(ownerId)) {
			throw new Error(
				`${name} must set OWNER_ID to a valid UUID test fixture`,
			);
		}
	}

	const scopedLive = jobs["scoped-live-integration"];
	if (!scopedLive) {
		throw new Error("Release workflow is missing scoped-live-integration");
	}
	const internalUrl = scopedLive.env?.STORAGE_INTERNAL_ENDPOINT_URL;
	const publicUrl = scopedLive.env?.STORAGE_PUBLIC_ENDPOINT_URL;
	if (
		typeof internalUrl !== "string" ||
		!internalUrl.startsWith("http://127.0.0.1:") ||
		publicUrl !== internalUrl
	) {
		throw new Error(
			"scoped-live-integration must keep explicit equal local HTTP storage URLs",
		);
	}
}

function reachesJob(
	jobs: Record<string, WorkflowJob>,
	start: string,
	target: string,
	seen = new Set<string>(),
): boolean {
	if (start === target) return true;
	if (seen.has(start)) return false;
	seen.add(start);
	const job = jobs[start];
	if (!job) return false;
	return needs(job).some((dependency) =>
		reachesJob(jobs, dependency, target, seen),
	);
}

export function validateReleaseWorkflow(workflow: Workflow): void {
	const jobs = workflow.jobs;
	if (!jobs) throw new Error("Release workflow has no jobs");
	validateDockerLifecycle(jobs);
	validateStorageEndpoints(jobs);

	for (const [name, commands] of Object.entries(requiredCommands)) {
		const job = jobs[name];
		if (!job) throw new Error(`Release workflow is missing ${name}`);
		const actual = jobCommands(job);
		for (const command of commands) {
			if (
				!actual.some((script) => {
					const lines = script.split("\n").map((line) => line.trim());
					return lines.some(
						(line) => line === command || line.startsWith(`${command} `),
					);
				})
			) {
				throw new Error(`${name} must run ${command}`);
			}
		}
	}

	const gate = jobs[completeGateJob];
	if (!gate?.if?.includes("refs/tags/v")) {
		throw new Error(`${completeGateJob} must remain tag-only`);
	}
	for (const dependency of completeGateDependencies) {
		if (!needs(gate).includes(dependency)) {
			throw new Error(`${completeGateJob} must depend on ${dependency}`);
		}
	}

	for (const name of publicationJobs) {
		const job = jobs[name];
		if (!job) throw new Error(`Release workflow is missing ${name}`);
		if (!job.if?.includes("refs/tags/v")) {
			throw new Error(`${name} must remain tag-only`);
		}
		if (!reachesJob(jobs, name, completeGateJob)) {
			throw new Error(
				`${name} must transitively depend on ${completeGateJob}`,
			);
		}
	}
}

export async function validateReleaseWorkflowContract(path: URL): Promise<void> {
	validateReleaseWorkflow(Bun.YAML.parse(await Bun.file(path).text()) as Workflow);
}

if (import.meta.main) {
	try {
		await validateReleaseWorkflowContract(
			new URL("../.github/workflows/ci.yml", import.meta.url),
		);
		console.log("Release workflow contract is valid");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
