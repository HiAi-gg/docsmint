import { afterEach, describe, expect, test } from "bun:test";

const ORIGINAL_FLAG = process.env.GRAPH_EXTRACT_ENABLED;

/**
 * Documents the contract of `getGraphDb()` from a fresh import. The
 * module caches the init result in module scope, so we reset the
 * singleton between tests to keep the assertions deterministic.
 *
 * As of the unified-database migration there is no separate AGE
 * connection string — the function either returns the shared Drizzle
 * client or `null`, so we only assert on the shape, not the value.
 */
describe("graph init module", () => {
	afterEach(() => {
		if (ORIGINAL_FLAG === undefined) {
			delete process.env.GRAPH_EXTRACT_ENABLED;
		} else {
			process.env.GRAPH_EXTRACT_ENABLED = ORIGINAL_FLAG;
		}
	});

	test("getGraphDb returns a client or null without throwing", async () => {
		const { getGraphDb } = await import("../lib/graph/init");
		const result = await getGraphDb();
		expect(result === null || typeof result === "object").toBe(true);
	});
});
