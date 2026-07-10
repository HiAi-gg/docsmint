import { describe, expect, test } from "bun:test";
import * as publicFrontend from "./index";

describe("public frontend entrypoints", () => {
	test("the SSR-safe root does not expose the legacy module singleton", () => {
		expect("docTabRegistry" in publicFrontend).toBe(false);
		expect("registerDocTab" in publicFrontend).toBe(false);
		expect(typeof publicFrontend.createFrontendExtensions).toBe("function");
	});

	test("the root entrypoint is directly importable outside Svelte compilation", () => {
		const first = publicFrontend.createFrontendExtensions();
		const second = publicFrontend.createFrontendExtensions();

		expect(first.documentTabs).not.toBe(second.documentTabs);
	});
});
