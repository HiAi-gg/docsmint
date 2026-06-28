import { describe, expect, test } from "bun:test";

describe("graph init module", () => {
	test("getGraphDb returns null when AGE_DATABASE_URL is not set", async () => {
		const prevUrl = process.env.AGE_DATABASE_URL;
		delete process.env.AGE_DATABASE_URL;
		// Force fresh config load
		const { _resetGraphForTests } = await import("../lib/graph/init");
		_resetGraphForTests();
		try {
			const { getGraphDb } = await import("../lib/graph/init");
			const result = await getGraphDb();
			expect(result).toBeNull();
		} finally {
			if (prevUrl !== undefined) process.env.AGE_DATABASE_URL = prevUrl;
		}
	});

	test("closeGraph is safe to call multiple times", async () => {
		const { closeGraph } = await import("../lib/graph/init");
		await closeGraph();
		await closeGraph();
		// No assertion — just verify it doesn't throw
		expect(true).toBe(true);
	});
});
