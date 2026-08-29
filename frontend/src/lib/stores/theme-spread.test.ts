import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

describe("circular theme spread", () => {
	test("spreads from the click through View Transitions and skips a DOM clone", () => {
		const store = read("./theme.svelte.ts");
		const settings = read("../components/SettingsDialog.svelte");
		const css = read("../../app.css");

		expect(store).toContain("spreadFromClick");
		expect(store).toContain("@hiai-gg/hiai-ui");
		expect(store).toContain("await tick()");
		expect(store).not.toContain("cloneNode");
		expect(settings).toContain("themeStore.spread");
		expect(settings).toContain("event.clientX");
		expect(css).toContain("@hiai-gg/hiai-ui/styles/tokens.css");
		expect(css).not.toContain("theme-clip-reveal");
	});
});
