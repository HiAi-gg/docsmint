import { describe, expect, test } from "bun:test";
import { documentEmbeddings } from "@hiai-docs/db/schema";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	EMBEDDING_NORM_EPSILON,
	embeddingHealthStatColumns,
} from "../embedding/validation";

describe("embedding health categories", () => {
	test("emits distinct SQL aggregates for null, zero, and near-zero vectors", () => {
		const dialect = new PgDialect();
		const columns = embeddingHealthStatColumns(documentEmbeddings.embedding);
		const rendered = Object.fromEntries(
			Object.entries(columns).map(([name, expression]) => [
				name,
				dialect.sqlToQuery(sql`SELECT ${expression}`),
			]),
		);

		expect(Object.keys(rendered).sort()).toEqual([
			"emptyChunks",
			"nearZeroChunks",
			"nullChunks",
			"zeroChunks",
		]);
		expect(rendered.nullChunks?.sql).toContain("IS NULL");
		expect(rendered.zeroChunks?.sql).toContain("vector_norm");
		expect(rendered.zeroChunks?.sql).toContain("= 0");
		expect(rendered.nearZeroChunks?.params).toContain(EMBEDDING_NORM_EPSILON);
		expect(rendered.emptyChunks?.params).toContain(EMBEDDING_NORM_EPSILON);
	});
});
