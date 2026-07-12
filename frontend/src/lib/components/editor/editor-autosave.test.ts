import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
	new URL("./HiAiEditor.svelte", import.meta.url),
	"utf8",
);

describe("visual editor autosave", () => {
	test("does not suppress the first user transaction after prop synchronization", () => {
		expect(source).toContain(
			"ed.commands.setContent(nextSource, { emitUpdate: false });",
		);
		expect(source).not.toContain("suppressNextUpdate");
	});

	test("forwards every non-collaborative TipTap update as markdown and JSON", () => {
		expect(source).toContain("onUpdate({ markdown, json });");
		expect(source).toContain("const json = ed.getJSON() as object;");
	});
});
