import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("hiai-ui DialogContent host contract", () => {
	test("every Dialog host wraps children in DialogContent", async () => {
		const failures: string[] = [];
		const root = resolve(import.meta.dir, "../..");

		for await (const file of new Bun.Glob("**/*.svelte").scan({
			cwd: root,
			absolute: true,
		})) {
			const source = await Bun.file(file).text();
			if (!source.includes("@hiai-gg/hiai-ui" + "/components/ui/dialog"))
				continue;
			const opensDialog =
				/<Dialog(?:\.Dialog)?[\s>]/.test(source) ||
				/<Dialog\n/.test(source);
			if (!opensDialog) continue;
			const hasContent =
				source.includes("<DialogContent") ||
				source.includes("<Dialog.DialogContent");
			if (!hasContent) failures.push(file);
		}

		expect(failures).toEqual([]);
	});
});
