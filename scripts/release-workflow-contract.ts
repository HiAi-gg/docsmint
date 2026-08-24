type WorkflowStep = Readonly<{ run?: string; uses?: string }>;
type WorkflowJob = Readonly<{
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
