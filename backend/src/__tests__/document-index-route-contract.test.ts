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

	test("fences warning retries to the current revision and uses a stable queue identity", () => {
		const routeBlock = source.slice(
			source.indexOf('"/documents/:id/pipeline/retry-warnings"'),
			source.indexOf('.get("/documents/:id",'),
		);
		expect(routeBlock).toContain(
			"eq(documents.contentHash, documentPipelineRuns.revision)",
		);
		expect(routeBlock).toContain(
			"warningRetryJobId(stage, retry.generationId)",
		);
		expect(routeBlock).toContain("deduplicated: true");
		expect(routeBlock).toContain('["retrying", "processing"].includes(');
		expect(routeBlock).toContain('existingRetryState === "completed"');
		expect(routeBlock).toContain('existingRetryState === "failed"');
		expect(routeBlock).toContain("await existingRetryJob?.remove()");
		expect(routeBlock).toContain("resolveActiveWarningRetry(");
		expect(routeBlock).not.toContain("Date.now()");
	});
});
