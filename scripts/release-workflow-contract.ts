type WorkflowStep = Readonly<{
	"continue-on-error"?: unknown;
	if?: string;
	name?: string;
	run?: string;
	uses?: string;
	with?: Readonly<Record<string, unknown>>;
}>;
type WorkflowJob = Readonly<{
	"continue-on-error"?: unknown;
	env?: Readonly<Record<string, unknown>>;
	if?: string;
	needs?: string | string[];
	steps?: WorkflowStep[];
}>;

type Workflow = Readonly<{
	jobs?: Record<string, WorkflowJob>;
}>;

function usesPinnedAction(
	step: WorkflowStep | undefined,
	action: string,
): step is WorkflowStep {
	return new RegExp(`^${action.replace("/", "\\/")}@[0-9a-f]{40}$`).test(
		step?.uses ?? "",
	);
}

const completeGateJob = "release-tag-gate";
const publicationJobs = [
	"publish-docker",
	"publish-npm",
	"verify-npm-provenance",
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
const tagReleaseCriticalJobs = [
	...completeGateDependencies,
	completeGateJob,
	...publicationJobs,
] as const;
const liveDockerJobs = [
	"docker-build",
	"scoped-live-integration",
	"browser-e2e",
] as const;
const productionDockerJobs = ["docker-build", "browser-e2e"] as const;
const workflowManagedLiveDockerJobs = ["scoped-live-integration"] as const;
const composeProjects = {
	"docker-build":
		"docsmint-release-docker-${{ github.run_id }}-${{ github.run_attempt }}",
	"browser-e2e":
		"docsmint-release-browser-${{ github.run_id }}-${{ github.run_attempt }}",
} as const;
const dockerEvidenceArtifactNames = {
	"docker-build": "release-docker-smoke-docker-build-${{ github.sha }}",
	"browser-e2e": "release-docker-smoke-browser-e2e-${{ github.sha }}",
} as const;
const dependencyStartCommand =
	"docker compose --env-file /dev/null up --detach --wait postgres redis seaweedfs";
const migrateCommand =
	"docker compose --env-file /dev/null run --rm --no-deps migrate";
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const productionPublicStorageUrl = "https://storage.release.invalid";
const productionInternalStorageUrl = "http://seaweedfs:8333";
const scopedLiveStorageUrl = "http://127.0.0.1:50702";
const requiredCommands: Readonly<Record<string, readonly string[]>> = {
	lint: ["bun run lint"],
	typecheck: ["bun run typecheck"],
	"unit-test": [
		"bun run release:check:audit",
		"bun run test:unit",
		"bun run test:contract",
	],
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
		"bun run release:check:docker-smoke",
	],
	"browser-e2e": [
		"bun run release:check:docker-smoke",
		"bun run release:check:browser",
	],
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

function isCanonicalEndpoint(
	value: unknown,
	expected: string,
	protocol: "http:" | "https:",
	hostname: string,
	port: string,
): boolean {
	if (typeof value !== "string" || value !== expected) return false;
	try {
		const parsed = new URL(value);
		return (
			parsed.protocol === protocol &&
			parsed.hostname === hostname &&
			parsed.port === port &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.pathname === "/" &&
			parsed.search === "" &&
			parsed.hash === ""
		);
	} catch {
		return false;
	}
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

	for (const name of workflowManagedLiveDockerJobs) {
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

}

function validateStorageEndpoints(jobs: Record<string, WorkflowJob>): void {
	for (const name of productionDockerJobs) {
		const job = jobs[name];
		if (!job) throw new Error(`Release workflow is missing ${name}`);
		const publicUrl = job.env?.STORAGE_PUBLIC_ENDPOINT_URL;
		if (
			!isCanonicalEndpoint(
				publicUrl,
				productionPublicStorageUrl,
				"https:",
				"storage.release.invalid",
				"",
			)
		) {
			throw new Error(
				`${name} must set STORAGE_PUBLIC_ENDPOINT_URL to an explicit HTTPS URL`,
			);
		}
		if (
			!isCanonicalEndpoint(
				job.env?.STORAGE_INTERNAL_ENDPOINT_URL,
				productionInternalStorageUrl,
				"http:",
				"seaweedfs",
				"8333",
			)
		) {
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
		!isCanonicalEndpoint(
			internalUrl,
			scopedLiveStorageUrl,
			"http:",
			"127.0.0.1",
			"50702",
		) ||
		!isCanonicalEndpoint(
			publicUrl,
			scopedLiveStorageUrl,
			"http:",
			"127.0.0.1",
			"50702",
		)
	) {
		throw new Error(
			"scoped-live-integration must keep explicit equal local HTTP storage URLs",
		);
	}
}

function validateDockerEvidence(jobs: Record<string, WorkflowJob>): void {
	for (const name of productionDockerJobs) {
		const job = jobs[name];
		if (!job) throw new Error(`Release workflow is missing ${name}`);
		if (job.env?.RELEASE_COMMIT !== "${{ github.sha }}") {
			throw new Error(`${name} must bind RELEASE_COMMIT to github.sha`);
		}
		if (job.env?.COMPOSE_PROJECT_NAME !== composeProjects[name]) {
			throw new Error(`${name} must use a run-isolated release Compose project`);
		}
		if (
			job.env?.RELEASE_DOCKER_EVIDENCE_DIRECTORY !==
			"build/release-evidence/docker-smoke"
		) {
			throw new Error(`${name} must use the canonical Docker evidence directory`);
		}
		const smokeCommand = "bun run release:check:docker-smoke";
		const smokeSteps = (job.steps ?? []).filter((step) =>
			step.run
				?.split("\n")
				.map((line) => line.trim())
				.includes(smokeCommand),
		);
		if (
			smokeSteps.length !== 1 ||
			smokeSteps[0]?.["continue-on-error"] === true ||
			!smokeSteps[0]?.run
				?.split("\n")
				.map((line) => line.trim())
				.includes("set -euo pipefail")
		) {
			throw new Error(
				`${name} must run the Docker smoke evidence command exactly once and fail closed`,
			);
		}
		const upload = job.steps?.find(
			(step) => step.name === "Upload commit-bound Docker smoke evidence",
		);
		if (!usesPinnedAction(upload, "actions/upload-artifact")) {
			throw new Error(`${name} must upload commit-bound Docker smoke evidence`);
		}
		if (
			upload.if !== "always()" ||
			upload.with?.path !== "build/release-evidence/docker-smoke/" ||
			upload.with?.["if-no-files-found"] !== "error"
		) {
			throw new Error(
				`${name} must upload build/release-evidence/docker-smoke/ with fail-closed settings`,
			);
		}
		if (
			upload.with?.name !== dockerEvidenceArtifactNames[name] ||
			upload["continue-on-error"] === true
		) {
			throw new Error(
				`${name} must upload Docker evidence with a commit-bound name and no error suppression`,
			);
		}
	}
}

function hasUnsafeErrorSuppression(
	node: WorkflowJob | WorkflowStep,
): boolean {
	return (
		Object.hasOwn(node, "continue-on-error") &&
		node["continue-on-error"] !== false
	);
}

function validateErrorSuppression(jobs: Record<string, WorkflowJob>): void {
	for (const name of tagReleaseCriticalJobs) {
		const job = jobs[name];
		if (!job) continue;
		if (
			hasUnsafeErrorSuppression(job) ||
			(job.steps ?? []).some(hasUnsafeErrorSuppression)
		) {
			throw new Error(
				`${name} must reject continue-on-error unless it is literal false`,
			);
		}
	}
}

function validatePublishedPackageProvenance(
	jobs: Record<string, WorkflowJob>,
): void {
	const provenance = jobs["verify-npm-provenance"];
	if (!provenance) {
		throw new Error("Release workflow is missing verify-npm-provenance");
	}
	if (provenance.env?.RELEASE_COMMIT !== "${{ github.sha }}") {
		throw new Error(
			"verify-npm-provenance must bind RELEASE_COMMIT to github.sha",
		);
	}
	if (provenance.env?.RELEASE_TAG !== "${{ github.ref_name }}") {
		throw new Error(
			"verify-npm-provenance must bind RELEASE_TAG to github.ref_name",
		);
	}
	if (!needs(provenance).includes("publish-npm")) {
		throw new Error("verify-npm-provenance must run after publish-npm");
	}
	const verification = provenance.steps?.find(
		(step) => step.name === "Verify exact tag commit and npm provenance",
	);
	const verificationIndex = provenance.steps?.indexOf(verification ?? {}) ?? -1;
	const installIndex =
		provenance.steps?.findIndex(
			(step) => step.run === "bun install --frozen-lockfile",
		) ?? -1;
	const verificationLines = verification?.run
		?.split("\n")
		.map((line) => line.trim());
	if (
		!verificationLines?.includes("set -euo pipefail") ||
		!verificationLines.includes(
			'test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$RELEASE_COMMIT"',
		) ||
		!verificationLines.includes(
			'RELEASE_VERSION="${RELEASE_TAG#v}" bun run scripts/verify-published-package.ts',
		) ||
		installIndex < 0 ||
		verificationIndex <= installIndex
	) {
		throw new Error(
			"verify-npm-provenance must install frozen dependencies before proving the exact tag commit and published package",
		);
	}
	const upload = provenance.steps?.find(
		(step) => step.name === "Upload commit-bound npm provenance evidence",
	);
	if (
		!usesPinnedAction(upload, "actions/upload-artifact") ||
		upload.with?.name !== "release-npm-provenance-${{ github.sha }}" ||
		upload.with?.path !== "build/release-evidence/npm-provenance/" ||
		upload.with?.["if-no-files-found"] !== "error"
	) {
		throw new Error(
			"verify-npm-provenance must upload commit-bound machine evidence",
		);
	}

	for (const downstream of ["publish-mcp-registry", "create-github-release"]) {
		const job = jobs[downstream];
		if (!job || !needs(job).includes("verify-npm-provenance")) {
			throw new Error(`${downstream} must depend on verified npm provenance`);
		}
	}

	if (
		!jobCommands(jobs["publish-mcp-registry"] ?? {}).some((command) =>
			command.includes("bun run scripts/validate-mcp-catalog.ts"),
		)
	) {
		throw new Error("publish-mcp-registry must validate MCP catalog manifests");
	}

	const publishNpm = jobs["publish-npm"];
	if (
		!jobCommands(publishNpm ?? {}).some((command) =>
			command.includes(
				'if npm view "@hiai-gg/docsmint@${version}" version >/dev/null 2>&1; then',
			),
		)
	) {
		throw new Error(
			"publish-npm must preserve the already-existing exact-version path",
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
	validateDockerEvidence(jobs);
	validateErrorSuppression(jobs);
	validatePublishedPackageProvenance(jobs);

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

export function validateManualMcpWorkflow(workflow: Workflow): void {
	const publish = workflow.jobs?.publish;
	const verification = publish?.steps?.find(
		(step) => step.name === "Verify exact tag commit and npm provenance",
	);
	const lines = verification?.run
		?.split("\n")
		.map((line) => line.trim()) ?? [];
	const checkout = publish?.steps?.find((step) =>
		usesPinnedAction(step, "actions/checkout"),
	);
	const verificationIndex = publish?.steps?.indexOf(verification ?? {}) ?? -1;
	const installIndex =
		publish?.steps?.findIndex(
			(step) => step.run === "bun install --frozen-lockfile",
		) ?? -1;
	const catalogIndex =
		publish?.steps?.findIndex(
			(step) => step.run === "bun run scripts/validate-mcp-catalog.ts",
		) ?? -1;
	const publicationIndex =
		publish?.steps?.findIndex((step) => step.run === "mcp-publisher publish") ?? -1;
	const upload = publish?.steps?.find(
		(step) => step.name === "Upload commit-bound npm provenance evidence",
	);
	if (
		!publish ||
		publish.env?.RELEASE_COMMIT !== "${{ inputs.release_commit }}" ||
		publish.env?.RELEASE_TAG !== "${{ inputs.release_tag }}" ||
		checkout?.with?.ref !== "${{ inputs.release_commit }}" ||
		checkout.with?.["fetch-depth"] !== 0 ||
		!lines.includes("set -euo pipefail") ||
		!lines.includes('test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"') ||
		!lines.includes(
			'test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$RELEASE_COMMIT"',
		) ||
		!lines.includes(
			'RELEASE_VERSION="${RELEASE_TAG#v}" bun run scripts/verify-published-package.ts',
		) ||
		installIndex < 0 ||
		verificationIndex <= installIndex ||
		verificationIndex < 0 ||
		catalogIndex <= verificationIndex ||
		publicationIndex <= catalogIndex ||
		!usesPinnedAction(upload, "actions/upload-artifact") ||
		upload.with?.name !==
			"manual-mcp-npm-provenance-${{ inputs.release_commit }}" ||
		upload.with?.["if-no-files-found"] !== "error" ||
		hasUnsafeErrorSuppression(publish) ||
		(publish.steps ?? []).some(hasUnsafeErrorSuppression)
	) {
		throw new Error(
			"manual MCP workflow must install frozen dependencies before proving the exact tag SHA and npm provenance",
		);
	}
}

export async function validateManualMcpWorkflowContract(path: URL): Promise<void> {
	validateManualMcpWorkflow(
		Bun.YAML.parse(await Bun.file(path).text()) as Workflow,
	);
}

if (import.meta.main) {
	try {
		await validateReleaseWorkflowContract(
			new URL("../.github/workflows/ci.yml", import.meta.url),
		);
		await validateManualMcpWorkflowContract(
			new URL("../.github/workflows/publish-mcp-registry.yml", import.meta.url),
		);
		console.log("Release workflow contract is valid");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
