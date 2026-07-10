import { describe, expect, test } from "bun:test";
import { createFrontendExtensions } from "./context";
import type { DocTabDefinition } from "./types";

describe("frontend extension manifest", () => {
	test("creates every extension category with isolated arrays", () => {
		const first = createFrontendExtensions();
		const second = createFrontendExtensions();

		expect(Object.keys(first)).toEqual([
			"navigation",
			"dashboardWidgets",
			"documentTabs",
			"editorActions",
			"documentMenuActions",
			"settingsSections",
			"commandPaletteActions",
		]);
		expect(first.navigation).not.toBe(second.navigation);
		expect(first.documentTabs).not.toBe(second.documentTabs);
	});

	test("preserves the existing document-tab contract", () => {
		const tab = {
			id: "html-preview",
			label: "HTML Preview",
			component: (() => null) as unknown as DocTabDefinition["component"],
		};
		const extensions = createFrontendExtensions({ documentTabs: [tab] });

		expect(extensions.documentTabs).toEqual([tab]);
	});

	test("copies supplied arrays so callers can safely reuse their input", () => {
		const navigation = [{ id: "templates", label: "Templates" }];
		const extensions = createFrontendExtensions({ navigation });

		navigation.push({ id: "billing", label: "Billing" });
		expect(extensions.navigation).toHaveLength(1);
	});

});
