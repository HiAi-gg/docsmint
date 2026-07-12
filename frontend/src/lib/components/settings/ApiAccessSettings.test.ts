import { describe, expect, test } from "bun:test";

const source = await Bun.file(
	`${import.meta.dir}/ApiAccessSettings.svelte`,
).text();

describe("API access settings", () => {
	test("renders each category key only in the canonical management list", () => {
		expect(source).toContain(">Category keys</h3>");
		expect(source).toContain("{#each categoryKeys as key (key.id)}");
		expect(source).not.toContain(">Category API access</h3>");
		expect(source).not.toContain(
			'categories.filter((category) => category.apiMode !== "unavailable")',
		);
	});

	test("keeps scrolling local to the key management list", () => {
		expect(source).toContain('aria-label="API key management list"');
		expect(source).toContain('class="max-h-72 space-y-5 overflow-y-auto pr-1"');
	});

	test("explains the one-time visibility rule for global keys", () => {
		expect(source).toContain("Global keys are shown once.");
		expect(source).not.toContain("Raw keys are shown once.");
	});
});
