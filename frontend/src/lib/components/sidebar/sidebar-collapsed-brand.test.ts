import { expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/Sidebar.svelte`).text();

test("collapsed sidebar uses the compact DocsMint favicon", () => {
	expect(source).toContain('src="/favicon.ico"');
	expect(source).toContain('src="/favicon_white.ico"');
	expect(source).toContain('href="https://docsmint.com"');
	expect(source).not.toContain('href="https://github.com/HiAi-gg/docsmint"');
	expect(source).not.toContain(
		'src="/favicon.ico" alt="DocsMint" class="size-5 object-contain dark:invert"',
	);
	expect(source).toContain('alt="DocsMint"');
	expect(source).not.toContain(">\n          DocsMint\n        </a>");
});

test("sidebar persists collapsed state locally", () => {
	expect(source).toContain(
		'const SIDEBAR_COLLAPSED_KEY = "hiai_sidebar_collapsed"',
	);
	expect(source).toContain("localStorage.getItem(SIDEBAR_COLLAPSED_KEY)");
	expect(source).toContain(
		'localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0")',
	);
});
