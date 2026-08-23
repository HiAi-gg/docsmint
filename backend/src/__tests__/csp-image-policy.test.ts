import { expect, test } from "bun:test";

test("accepts HTTPS document images in the API content security policy", async () => {
	const source = await Bun.file(`${import.meta.dir}/../index.ts`).text();
	expect(source).toContain("img-src 'self' data: blob: https:");
});
