import { expect, test } from "bun:test";

import { validateReleaseJobResults } from "./write-release-gate-result.ts";

const successfulResults = {
	lint: { result: "success" },
	typecheck: { result: "success" },
	"unit-test": { result: "success" },
	"integration-test": { result: "success" },
	"scoped-live-integration": { result: "success" },
	build: { result: "success" },
	"package-consumer": { result: "success" },
	"docker-build": { result: "success" },
	"browser-e2e": { result: "success" },
	"release-static-gates": { result: "success" },
} as const;

test("complete release result requires every prerequisite to succeed", () => {
	expect(() => validateReleaseJobResults(successfulResults)).not.toThrow();
	expect(() =>
		validateReleaseJobResults({
			...successfulResults,
			"browser-e2e": { result: "skipped" },
		}),
	).toThrow("Release prerequisite did not succeed: browser-e2e");
});
