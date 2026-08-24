type WorkflowJob = Readonly<{
	if?: string;
	needs?: string | string[];
	steps?: Array<Readonly<{ run?: string }>>;
}>;

type Workflow = Readonly<{
	jobs?: Record<string, WorkflowJob>;
}>;

const gateJobName = "contract-evidence-prepublish";
const publicationJobs = [
	"publish-docker",
	"publish-npm",
	"publish-mcp-registry",
	"create-github-release",
] as const;

function needs(job: WorkflowJob): string[] {
	if (Array.isArray(job.needs)) return job.needs;
	return job.needs ? [job.needs] : [];
}

export async function validateReleaseWorkflowContract(path: URL): Promise<void> {
	const workflow = Bun.YAML.parse(await Bun.file(path).text()) as Workflow;
	const jobs = workflow.jobs;
	if (!jobs) throw new Error("Release workflow has no jobs");
	const gate = jobs[gateJobName];
	if (!gate) throw new Error(`Release workflow is missing ${gateJobName}`);
	if (!gate.if?.includes("refs/tags/v")) {
		throw new Error("Contract evidence gate must run on version tags");
	}
	if (
		!gate.steps?.some(
			(step) => step.run?.trim() === "bun run release:check:contract-evidence",
		)
	) {
		throw new Error("Contract evidence gate must run the strict prepublish validator");
	}

	for (const name of publicationJobs) {
		const job = jobs[name];
		if (!job) throw new Error(`Release workflow is missing ${name}`);
		if (!job.if?.includes("refs/tags/v")) {
			throw new Error(`${name} must remain tag-only`);
		}
		if (!needs(job).includes(gateJobName)) {
			throw new Error(`${name} must depend on ${gateJobName}`);
		}
	}
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
