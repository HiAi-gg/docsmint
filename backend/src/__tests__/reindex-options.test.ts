import { describe, expect, test } from "bun:test";
import { parseReindexOptions } from "../scripts/reindex-options";

describe("resumable full reindex options", () => {
	test("accepts all-document mode with a resume cursor", () => {
		expect(
			parseReindexOptions(["--all", "--after=doc-100", "--batch=25"]),
		).toEqual({
			after: "doc-100",
			batch: 25,
			dryRun: false,
			all: true,
		});
	});
});
