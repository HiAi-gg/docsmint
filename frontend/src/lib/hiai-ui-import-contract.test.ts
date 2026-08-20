import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

const HIAI_UI_IMPORT = /["'](@hiai-gg\/hiai-ui\/[^"']+)["']/g;

describe("hiai-ui package import contract", () => {
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
