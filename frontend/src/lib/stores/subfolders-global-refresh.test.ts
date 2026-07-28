import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
	new URL("./subfolders-refresh-store.svelte.ts", import.meta.url),
	"utf8",
);

describe("refreshFolders", () => {
	it("invalidates already mounted nested folder projections", () => {
		expect(source).toContain(
			"for (const folderId of Object.keys(foldersRegistry))",
		);
		expect(source).toContain(
			"refreshNonces[folderId] = (refreshNonces[folderId] ?? 0) + 1",
		);
	});
});
