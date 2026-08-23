import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const manifest = JSON.parse(
	readFileSync(new URL("package.public.json", root), "utf8"),
);

test("publishes reusable editor preferences and compact editor entrypoints", () => {
	expect(manifest.exports["./frontend/editor-preferences"]).toBeDefined();
	expect(
		manifest.exports["./frontend/components/editor/compact-editor"],
	).toBeDefined();
});

test("ShareDialog exposes the created restricted link to hosts", () => {
	const source = readFileSync(
		new URL("frontend/src/lib/components/ShareDialog.svelte", root),
		"utf8",
	);
	expect(source).toContain("onCreated?: (result: ShareCreatedResult) => void");
	expect(source).toContain("onCreated?.({");
	expect(source).toContain("data-share-created-url");
	expect(source).toContain("data-share-copy-action");
	expect(source).toContain("flex-col gap-2 sm:flex-row");
	expect(source).toContain("break-all");
	expect(source).not.toContain(
		'{#if accessMode === "public"}<div class="flex items-center gap-2">',
	);
});

test("ShareDialog publishes an additive standalone display mode", () => {
	const declarations = readFileSync(
		new URL("../scripts/write-frontend-declarations.ts", import.meta.url),
		"utf8",
	);
	expect(declarations).toContain('displayMode?: "host-managed" | "standalone"');
});
