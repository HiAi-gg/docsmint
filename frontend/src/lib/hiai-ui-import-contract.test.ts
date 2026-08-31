import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

const HIAI_UI_IMPORT = /["'](@hiai-gg\/hiai-ui\/[^"']+)["']/g;

describe("hiai-ui package import contract", () => {
	test("theme spread uses the installed package root export", async () => {
		const themeStore = await Bun.file(
			resolve(import.meta.dir, "stores/theme.svelte.ts"),
		).text();
		expect(themeStore).toContain('from "@hiai-gg/hiai-ui"');
		expect(themeStore).not.toContain("@hiai-gg/hiai-ui/lib/theme-spread");

		const entry = import.meta.resolve("@hiai-gg/hiai-ui");
		const packageRoot = resolve(dirname(new URL(entry).pathname), "..");
		const manifest = await Bun.file(
			resolve(packageRoot, "package.json"),
		).json();
		const rootExport = manifest.exports?.["."] as
			| Record<string, string>
			| undefined;
		expect(rootExport?.types).toBe("./dist/index.d.ts");
		expect(rootExport?.svelte).toBe("./dist/index.js");

		const declarations = await Bun.file(
			resolve(packageRoot, rootExport?.types ?? ""),
		).text();
		const runtime = await Bun.file(
			resolve(packageRoot, rootExport?.svelte ?? ""),
		).text();
		expect(declarations).toContain("runThemeSpread");
		expect(runtime).toContain("runThemeSpread");

		const svelteConfig = await Bun.file(
			resolve(import.meta.dir, "../../svelte.config.js"),
		).text();
		expect(svelteConfig).not.toContain("hiaiUiDist");
		expect(svelteConfig).not.toContain('"@hiai-gg/hiai-ui"');
	});

	test("every frontend import resolves to an exported package target", async () => {
		const entry = import.meta.resolve("@hiai-gg/hiai-ui");
		const packageRoot = resolve(dirname(new URL(entry).pathname), "..");
		const manifest = await Bun.file(
			resolve(packageRoot, "package.json"),
		).json();
		const exports = manifest.exports as Record<string, unknown>;
		const failures: string[] = [];

		for await (const file of new Bun.Glob("src/**/*.{ts,svelte}").scan({
			cwd: resolve(import.meta.dir, "../.."),
			absolute: true,
		})) {
			const source = await Bun.file(file).text();
			for (const match of source.matchAll(HIAI_UI_IMPORT)) {
				const specifier = match[1];
				if (!specifier) continue;
				const subpath = `.${specifier.slice("@hiai-gg/hiai-ui".length)}`;
				if (subpath in exports) continue;
				const wildcard = Object.keys(exports).find((key) => {
					if (!key.includes("*")) return false;
					const [prefix, suffix = ""] = key.split("*");
					return subpath.startsWith(prefix ?? "") && subpath.endsWith(suffix);
				});
				if (!wildcard) failures.push(`${file}: ${specifier}`);
				else {
					const target = exports[wildcard];
					if (typeof target !== "string")
						failures.push(`${file}: ${specifier}`);
					else {
						const [prefix, suffix = ""] = wildcard.split("*");
						const captured = subpath.slice(
							prefix?.length ?? 0,
							subpath.length - suffix.length,
						);
						const resolvedTarget = target.replace("*", captured);
						const exactTarget = Bun.file(resolve(packageRoot, resolvedTarget));
						const javascriptTarget = Bun.file(
							resolve(packageRoot, `${resolvedTarget}.js`),
						);
						if (
							!(await exactTarget.exists()) &&
							!(await javascriptTarget.exists())
						) {
							failures.push(`${file}: ${specifier} -> ${resolvedTarget}`);
						}
					}
				}
			}
		}

		expect(failures).toEqual([]);
	});
});
