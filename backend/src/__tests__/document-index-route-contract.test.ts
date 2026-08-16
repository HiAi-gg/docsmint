import { describe, expect, test } from "bun:test";

const source = await Bun.file(
	new URL("../api/routes/documents.ts", import.meta.url),
).text();

describe("document knowledge route contract", () => {
	test("validates all three route ids before querying UUID columns", () => {
		expect(
			source.match(/documentIdParamsSchema\.safeParse\(params\)/g),
		).toHaveLength(3);
	});

	test("rate limits summary and status reads plus index refresh writes", () => {
		const routeBlock = source.slice(
			source.indexOf('.get("/documents/:id/knowledge-summary"'),
			source.indexOf('.get("/documents/:id",'),
		);
		expect(routeBlock.match(/documentRateLimiter\(/g)).toHaveLength(2);
		expect(routeBlock.match(/writeRateLimiter\(/g)).toHaveLength(1);
		expect(routeBlock).toContain("set.status = 429");
	});
});
