import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GraphSqlClient } from "../lib/graph/init";

const unsafeQueries: string[] = [];
const taggedQueries: string[] = [];

const tx = Object.assign(
	mock(async (strings: TemplateStringsArray) => {
		const query = strings.join("?");
		taggedQueries.push(query);
		return query.includes("FOR UPDATE") ? [{ id: "document-id" }] : [];
	}),
	{
		unsafe: mock(async (query: string) => {
			unsafeQueries.push(query);
			return [];
		}),
	},
);

const graphSql = Object.assign(
	mock(async () => []),
	{
		begin: mock(async (callback: (transaction: typeof tx) => Promise<void>) =>
			callback(tx),
		),
	},
);

function applyMocks(): void {
	mock.module("../lib/config", () => ({
		config: {
			GRAPH_EXTRACT_ENABLED: true,
			GRAPH_EXTRACT_MIN_CONFIDENCE: 0.5,
			GRAPH_EXTRACT_BASE_URL: "",
			GRAPH_EXTRACT_FALLBACK_BASE_URL: "",
			OPENROUTER_API_KEY: "",
		},
	}));
	mock.module("../lib/logger", () => ({
		logger: {
			debug: () => {},
			warn: () => {},
		},
	}));
	mock.module("../lib/redis", () => ({
		redis: {
			set: async () => "OK",
			del: async () => 1,
		},
	}));
	mock.module("../lib/graph/init", () => ({
		getGraphDb: async () => graphSql as unknown as GraphSqlClient,
		getGraphDbRequired: async () => graphSql as unknown as GraphSqlClient,
		_resetGraphForTests: () => {},
	}));
}

beforeAll(applyMocks);
beforeEach(() => {
	applyMocks();
	unsafeQueries.length = 0;
	taggedQueries.length = 0;
});

describe("empty graph projection lifecycle", () => {
	test("whitespace content clears the prior projection and stamps the active generation", async () => {
		const fetchMock = mock(async () => {
			throw new Error("empty extraction must not call the provider");
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const { extractEntities } = await import("../lib/graph/extract-entities");
			const result = await extractEntities(" \n\t ", "document-id", {
				generationId: "00000000-0000-4000-8000-000000000002",
				revision: "revision-current",
			});

			expect(result).toEqual({ status: "ready", entities: [] });
			expect(fetchMock).not.toHaveBeenCalled();
			expect(taggedQueries.some((query) => query.includes("FOR UPDATE"))).toBe(
				true,
			);
			expect(unsafeQueries).toHaveLength(3);
			const projection = unsafeQueries.join("\n");
			expect(projection).toContain('r.document_id = "document-id"');
			expect(projection).toContain(
				'd.generation_id = "00000000-0000-4000-8000-000000000002"',
			);
			expect(projection).toContain('d.revision = "revision-current"');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
