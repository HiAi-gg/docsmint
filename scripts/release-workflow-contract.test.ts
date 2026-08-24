import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateReleaseWorkflowContract } from "./release-workflow-contract";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
	);
});

async function mutatedWorkflow(
	mutate: (workflow: Record<string, unknown>) => void,
): Promise<URL> {
	const current = Bun.YAML.parse(
		await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text(),
	) as Record<string, unknown>;
	mutate(current);
	const directory = await mkdtemp(join(tmpdir(), "docsmint-release-workflow-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "ci.yml");
	await Bun.write(path, JSON.stringify(current));
	return Bun.pathToFileURL(path);
}

function workflowJob(
	workflow: Record<string, unknown>,
	name: string,
): { env?: Record<string, unknown>; steps?: Array<Record<string, unknown>> } {
	const jobs = workflow.jobs as Record<
		string,
		{ env?: Record<string, unknown>; steps?: Array<Record<string, unknown>> }
	>;
	const job = jobs[name];
	if (!job) throw new Error(`Missing workflow fixture job: ${name}`);
	return job;
}

function workflowStep(
	workflow: Record<string, unknown>,
	jobName: string,
	stepName: string,
): Record<string, unknown> {
	const step = workflowJob(workflow, jobName).steps?.find(
		(candidate) => candidate.name === stepName,
	);
	if (!step) {
		throw new Error(`Missing workflow fixture step: ${jobName}/${stepName}`);
	}
	return step;
}

test("every tag publication transitively depends on the complete release gate", async () => {
	await expect(
		validateReleaseWorkflowContract(
			new URL("../.github/workflows/ci.yml", import.meta.url),
		),
	).resolves.toBeUndefined();
});

test("workflow validation rejects a publication path that bypasses the complete gate", async () => {
	const path = await mutatedWorkflow((workflow) => {
		const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
		jobs["publish-npm"].needs = ["lint"];
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"publish-npm must transitively depend on release-tag-gate",
	);
});

test("workflow validation rejects removal of the production audit", async () => {
	const path = await mutatedWorkflow((workflow) => {
		const jobs = workflow.jobs as Record<
			string,
			{ steps?: Array<Record<string, unknown>> }
		>;
		const gate = jobs["release-static-gates"];
		if (!gate) return;
		const steps = gate.steps ?? [];
		gate.steps = steps.filter(
			(step) => step.run !== "bun run release:check:audit",
		);
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"release-static-gates must run bun run release:check:audit",
	);
});

test("workflow validation rejects removal of the executable Lightpanda browser gate", async () => {
	const path = await mutatedWorkflow((workflow) => {
		const jobs = workflow.jobs as Record<
			string,
			{ steps?: Array<Record<string, unknown>> }
		>;
		const gate = jobs["browser-e2e"];
		if (!gate) return;
		const steps = gate.steps ?? [];
		gate.steps = steps.filter(
			(step) => step.run !== "bun run release:check:browser",
		);
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"browser-e2e must run bun run release:check:browser",
	);
});

test("workflow validation rejects one-shot migrations inside compose up --wait", async () => {
	const path = await mutatedWorkflow((workflow) => {
		workflowStep(
			workflow,
			"docker-build",
			"Smoke test backend image against healthy services",
		).run = [
			"set -euo pipefail",
			"docker compose --env-file /dev/null up --detach --wait postgres redis seaweedfs migrate",
			"docker compose --env-file /dev/null up --detach --no-build --wait api",
		].join("\n");
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"docker-build must not run migrate through docker compose up --wait",
	);
});

test("workflow validation rejects an implicit all-service compose up --wait", async () => {
	const path = await mutatedWorkflow((workflow) => {
		workflowStep(
			workflow,
			"browser-e2e",
			"Rebuild and start the complete release stack",
		).run = [
			"docker compose --env-file /dev/null build",
			"docker compose --env-file /dev/null up --detach --wait",
		].join("\n");
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"browser-e2e must explicitly start only long-running dependencies before migrate",
	);
});

test("workflow validation requires a standalone zero-exit migrate command in every live Docker job", async () => {
	for (const jobName of [
		"docker-build",
		"scoped-live-integration",
		"browser-e2e",
	]) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, jobName);
			for (const step of job.steps ?? []) {
				if (typeof step.run === "string") {
					step.run = step.run
						.split("\n")
						.filter(
							(line) =>
								line.trim() !==
								"docker compose --env-file /dev/null run --rm --no-deps migrate",
						)
						.join("\n");
				}
			}
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			`${jobName} must run docker compose --env-file /dev/null run --rm --no-deps migrate`,
		);
	}
});

test("workflow validation requires dependencies before standalone migrations", async () => {
	const path = await mutatedWorkflow((workflow) => {
		workflowStep(
			workflow,
			"scoped-live-integration",
			"Start isolated required services and migrations",
		).run = [
			"docker compose --env-file /dev/null run --rm --no-deps migrate",
			"docker compose --env-file /dev/null up --detach --wait postgres redis seaweedfs",
		].join("\n");
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"scoped-live-integration must start long-running dependencies before standalone migrate",
	);
});

test("workflow validation requires API and web startup after browser migrations", async () => {
	const path = await mutatedWorkflow((workflow) => {
		workflowStep(
			workflow,
			"browser-e2e",
			"Rebuild and start the complete release stack",
		).run = [
			"docker compose --env-file /dev/null build",
			"docker compose --env-file /dev/null up --detach --wait postgres redis seaweedfs",
			"docker compose --env-file /dev/null run --rm --no-deps migrate",
		].join("\n");
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"browser-e2e must start API and web after standalone migrate",
	);
});

test("workflow validation requires HTTPS public storage in production Docker jobs", async () => {
	for (const jobName of ["docker-build", "browser-e2e"]) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, jobName);
			job.env = {
				...job.env,
				STORAGE_PUBLIC_ENDPOINT_URL: "http://seaweedfs:8333",
			};
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			`${jobName} must set STORAGE_PUBLIC_ENDPOINT_URL to an explicit HTTPS URL`,
		);
	}
});

test("workflow validation preserves internal SeaweedFS HTTP in production Docker jobs", async () => {
	for (const jobName of ["docker-build", "browser-e2e"]) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, jobName);
			job.env = {
				...job.env,
				STORAGE_INTERNAL_ENDPOINT_URL: "https://storage.release.invalid",
			};
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			`${jobName} must keep STORAGE_INTERNAL_ENDPOINT_URL on http://seaweedfs:8333`,
		);
	}
});

test("workflow validation requires a valid deterministic owner in production Docker jobs", async () => {
	for (const jobName of ["docker-build", "browser-e2e"]) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, jobName);
			job.env = { ...job.env, OWNER_ID: "" };
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			`${jobName} must set OWNER_ID to a valid UUID test fixture`,
		);
	}
});

test("workflow validation preserves scoped-live local public and internal storage equality", async () => {
	const path = await mutatedWorkflow((workflow) => {
		const job = workflowJob(workflow, "scoped-live-integration");
		job.env = {
			...job.env,
			STORAGE_PUBLIC_ENDPOINT_URL: "https://storage.release.invalid",
		};
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"scoped-live-integration must keep explicit equal local HTTP storage URLs",
	);
});
