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

test("workflow validation requires commit-bound Docker smoke evidence in every production Docker job", async () => {
	for (const jobName of ["docker-build", "browser-e2e"]) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, jobName);
			for (const step of job.steps ?? []) {
				if (typeof step.run === "string") {
					step.run = step.run
						.split("\n")
						.filter(
							(line) => line.trim() !== "bun run release:check:docker-smoke",
						)
						.join("\n");
				}
			}
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			`${jobName} must run the Docker smoke evidence command exactly once and fail closed`,
		);
	}
});

test("workflow validation rejects self-asserted Docker smoke labels", async () => {
	const path = await mutatedWorkflow((workflow) => {
		workflowStep(
			workflow,
			"browser-e2e",
			"Rebuild and start the complete release stack",
		).run = [
			"docker compose --env-file /dev/null build",
			"RELEASE_DOCKER_SMOKE_VERIFIED=true",
		].join("\n");
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"browser-e2e must run the Docker smoke evidence command exactly once and fail closed",
	);
});

test("workflow validation rejects a softened Docker smoke command", async () => {
	const path = await mutatedWorkflow((workflow) => {
		const step = workflowStep(
			workflow,
			"docker-build",
			"Smoke test backend image against healthy services",
		);
		step.run = String(step.run).replace(
			"bun run release:check:docker-smoke",
			"bun run release:check:docker-smoke || true",
		);
	});

	await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
		"docker-build must run the Docker smoke evidence command exactly once and fail closed",
	);
});

test("workflow validation requires exact commit and isolated Compose project bindings", async () => {
	for (const [environmentName, value, message] of [
		[
			"RELEASE_COMMIT",
			"caller-supplied-commit",
			"docker-build must bind RELEASE_COMMIT to github.sha",
		],
		[
			"COMPOSE_PROJECT_NAME",
			"docsmint-shared",
			"docker-build must use a run-isolated release Compose project",
		],
	] as const) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, "docker-build");
			job.env = { ...job.env, [environmentName]: value };
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(message);
	}
});

test("workflow validation requires fail-closed Docker evidence artifact upload", async () => {
	for (const [jobName, mutation, message] of [
		[
			"docker-build",
			(step: Record<string, unknown>) => {
				step.uses = "actions/upload-artifact@v3";
			},
			"docker-build must upload commit-bound Docker smoke evidence",
		],
		[
			"browser-e2e",
			(step: Record<string, unknown>) => {
				step.with = { path: "build/release-evidence/browser/" };
			},
			"browser-e2e must upload build/release-evidence/docker-smoke/ with fail-closed settings",
		],
	] as const) {
		const path = await mutatedWorkflow((workflow) => {
			mutation(
				workflowStep(
					workflow,
					jobName,
					"Upload commit-bound Docker smoke evidence",
				),
			);
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(message);
	}
});

test("workflow validation rejects unbound or non-fatal Docker evidence uploads", async () => {
	for (const [field, value] of [
		["name", "release-docker-smoke-unbound"],
		["continue-on-error", true],
	] as const) {
		const path = await mutatedWorkflow((workflow) => {
			const upload = workflowStep(
				workflow,
				"browser-e2e",
				"Upload commit-bound Docker smoke evidence",
			);
			if (field === "name") {
				const configuration = upload.with as Record<string, unknown>;
				configuration.name = value;
			} else {
				upload[field] = value;
			}
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			"browser-e2e must upload Docker evidence with a commit-bound name and no error suppression",
		);
	}
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

test("workflow validation requires a standalone zero-exit migrate command in scoped live integration", async () => {
	const path = await mutatedWorkflow((workflow) => {
		const job = workflowJob(workflow, "scoped-live-integration");
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
		"scoped-live-integration must run docker compose --env-file /dev/null run --rm --no-deps migrate",
	);
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
		"browser-e2e must run the Docker smoke evidence command exactly once and fail closed",
	);
});

test("workflow validation forbids application startup from traversing migrate dependencies", async () => {
	for (const [jobName, stepName, run] of [
		[
			"docker-build",
			"Smoke test backend image against healthy services",
			[
				"docker compose --env-file /dev/null up --detach --wait postgres redis seaweedfs",
				"docker compose --env-file /dev/null run --rm --no-deps migrate",
				"docker compose --env-file /dev/null up --detach --no-build --wait api",
			].join("\n"),
		],
		[
			"browser-e2e",
			"Rebuild and start the complete release stack",
			[
				"docker compose --env-file /dev/null build",
				"docker compose --env-file /dev/null up --detach --wait postgres redis seaweedfs",
				"docker compose --env-file /dev/null run --rm --no-deps migrate",
				"docker compose --env-file /dev/null up --detach --wait api web",
			].join("\n"),
		],
	] as const) {
		const path = await mutatedWorkflow((workflow) => {
			workflowStep(workflow, jobName, stepName).run = run;
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			`${jobName} must run the Docker smoke evidence command exactly once and fail closed`,
		);
	}
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

test("workflow validation rejects malformed or non-canonical production public storage URLs", async () => {
	for (const publicUrl of [
		"https://",
		"https://release-user:release-password@storage.release.invalid",
		"http://storage.release.invalid",
		"https://storage.example.invalid",
		"https://storage.release.invalid:443",
	]) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, "docker-build");
			job.env = { ...job.env, STORAGE_PUBLIC_ENDPOINT_URL: publicUrl };
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			"docker-build must set STORAGE_PUBLIC_ENDPOINT_URL to an explicit HTTPS URL",
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

test("workflow validation rejects malformed or non-canonical internal SeaweedFS URLs", async () => {
	for (const internalUrl of [
		"http://seaweedfs::8333",
		"https://seaweedfs:8333",
		"http://release-user:release-password@seaweedfs:8333",
		"http://127.0.0.1:8333",
		"http://seaweedfs:8334",
	]) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, "browser-e2e");
			job.env = { ...job.env, STORAGE_INTERNAL_ENDPOINT_URL: internalUrl };
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			"browser-e2e must keep STORAGE_INTERNAL_ENDPOINT_URL on http://seaweedfs:8333",
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

test("workflow validation rejects malformed or equality-preserving wrong scoped-live URLs", async () => {
	for (const [internalUrl, publicUrl] of [
		["http://127.0.0.1::50702", "http://127.0.0.1::50702"],
		["https://127.0.0.1:50702", "https://127.0.0.1:50702"],
		["http://localhost:50702", "http://localhost:50702"],
		["http://127.0.0.1:50703", "http://127.0.0.1:50703"],
		[
			"http://release-user:release-password@127.0.0.1:50702",
			"http://release-user:release-password@127.0.0.1:50702",
		],
	] as const) {
		const path = await mutatedWorkflow((workflow) => {
			const job = workflowJob(workflow, "scoped-live-integration");
			job.env = {
				...job.env,
				STORAGE_INTERNAL_ENDPOINT_URL: internalUrl,
				STORAGE_PUBLIC_ENDPOINT_URL: publicUrl,
			};
		});

		await expect(validateReleaseWorkflowContract(path)).rejects.toThrow(
			"scoped-live-integration must keep explicit equal local HTTP storage URLs",
		);
	}
});
