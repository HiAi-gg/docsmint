import { expect, test } from "bun:test";

import { validateReleaseWorkflowContract } from "./release-workflow-contract";

test("tag publication depends on the strict prepublish evidence gate", async () => {
	await expect(
		validateReleaseWorkflowContract(
			new URL("../.github/workflows/ci.yml", import.meta.url),
		),
	).resolves.toBeUndefined();
});
