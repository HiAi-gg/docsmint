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
