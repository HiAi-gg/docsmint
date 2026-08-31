import { describe, expect, test } from "bun:test";

const source = await Bun.file(
	new URL("../api/routes/documents.ts", import.meta.url),
).text();

describe("document knowledge route contract", () => {
	test("validates all four route ids before querying UUID columns", () => {
		expect(
			source.match(/documentIdParamsSchema\.safeParse\(params\)/g),
		).toHaveLength(4);
	});

	test("rate limits summary and status reads plus warning retry and index refresh writes", () => {
		const routeBlock = source.slice(
			source.indexOf('"/documents/:id/pipeline/retry-warnings"'),
			source.indexOf('.get("/documents/:id",'),
		);
		expect(routeBlock.match(/documentRateLimiter\(/g)).toHaveLength(2);
		expect(routeBlock.match(/writeRateLimiter\(/g)).toHaveLength(2);
		expect(routeBlock).toContain("set.status = 429");
	});
});
