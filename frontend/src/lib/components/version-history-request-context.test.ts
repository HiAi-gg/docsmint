import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (name: string) =>
	readFileSync(new URL(name, import.meta.url), "utf8");

describe("version history workspace request context", () => {
	test.each([
		"./CreateSnapshotDialog.svelte",
		"./VersionHistory.svelte",
		"./VersionDiff.svelte",
	])("%s routes requests through the injected adapter", (name) => {
		const source = read(name);
		expect(source).toContain("getDocsmintRequestAdapter");
		expect(source).toContain("request.fetch");
	});
});
