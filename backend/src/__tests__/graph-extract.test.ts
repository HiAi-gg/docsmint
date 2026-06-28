import { describe, expect, test } from "bun:test";

describe("graph extract-entities module", () => {
	test("extractEntities returns [] when GRAPH_EXTRACT_ENABLED is false", async () => {
		const prev = process.env.GRAPH_EXTRACT_ENABLED;
		process.env.GRAPH_EXTRACT_ENABLED = "false";
		const { _resetGraphForTests } = await import("../lib/graph/init");
		_resetGraphForTests();
		try {
			const { extractEntities } = await import("../lib/graph/extract-entities");
			const result = await extractEntities("Some text", "doc-1");
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.GRAPH_EXTRACT_ENABLED;
			else process.env.GRAPH_EXTRACT_ENABLED = prev;
		}
	});

	test("extractEntities returns [] when chunk text is empty/whitespace", async () => {
		const prev = process.env.GRAPH_EXTRACT_ENABLED;
		process.env.GRAPH_EXTRACT_ENABLED = "true";
		const { _resetGraphForTests } = await import("../lib/graph/init");
		_resetGraphForTests();
		try {
			const { extractEntities } = await import("../lib/graph/extract-entities");
			const a = await extractEntities("", "doc-1");
			expect(a.length).toBe(0);
			const b = await extractEntities("   \n\t  ", "doc-1");
			expect(b.length).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.GRAPH_EXTRACT_ENABLED;
			else process.env.GRAPH_EXTRACT_ENABLED = prev;
		}
	});
});
