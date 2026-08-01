import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
	new URL("./HiaiDocsDashboardHost.svelte", import.meta.url),
	"utf8",
);

describe("dashboard document deletion", () => {
	it("uses the branded confirmation dialog instead of browser confirm", () => {
		expect(source).not.toContain("window.confirm");
		expect(source).toContain("showDeleteDocumentDialog");
		expect(source).toContain("confirmDeleteDocument");
		expect(source).toContain("Move to Trash");
	});
});
