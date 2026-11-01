import { expect, test } from "bun:test";
import { and, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
	documentListConditions,
	documentListFingerprint,
	documentListOrder,
	documentListQuerySchema,
} from "../lib/document-list-query";
import {
	documentLocation,
	documentPreview,
} from "../lib/document-presentation";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const ctx = {
	userId: first,
	role: "user" as const,
	source: "personal" as const,
};
const dialect = new PgDialect();

test("list rejects ambiguous filters and invalid date or boolean input", () => {
	for (const query of [
		{ folderId: first, rootOnly: "true" },
		{ tag: first, tagIds: second },
		{ updatedFrom: "2026-01-01" },
		{ updatedFrom: "2026-02-01T00:00:00Z", updatedTo: "2026-01-01T00:00:00Z" },
		{ rootOnly: "yes" },
		{ tagIds: "not-uuid" },
	]) {
		expect(documentListQuerySchema.safeParse(query).success).toBe(false);
	}
	expect(documentListQuerySchema.parse({ rootOnly: "false" }).rootOnly).toBe(
		false,
	);
});

test("tag IDs normalize into a bounded deduplicated filter and default all matching", () => {
	const query = documentListQuerySchema.parse({
		tagIds: `${second},${first},${first}`,
	});
	expect(query.tagIds).toEqual([first, second]);
	expect(query.tagMatch).toBe("all");
	const all = dialect.sqlToQuery(
		and(...documentListConditions(ctx, query)) ?? sql`false`,
	);
	expect(all.sql.match(/EXISTS/g)).toHaveLength(2);
	expect(all.params).toContain(first);
	expect(all.params).toContain(second);
	expect(all.sql).toContain("list_tag.owner_id");
	const any = dialect.sqlToQuery(
		and(...documentListConditions(ctx, { ...query, tagMatch: "any" })) ??
			sql`false`,
	);
	expect(any.sql).toContain(" or ");
});

test("q remains a bound literal substring and date range is half-open", () => {
	const query = documentListQuerySchema.parse({
		q: "%_'\\",
		updatedFrom: "2026-01-01T00:00:00Z",
		updatedTo: "2026-02-01T00:00:00Z",
		rootOnly: "true",
	});
	const rendered = dialect.sqlToQuery(
		and(...documentListConditions(ctx, query)) ?? sql`false`,
	);
	expect(rendered.sql).toContain("position(lower(");
	expect(rendered.sql).not.toContain("ilike");
	expect(rendered.sql).toContain('"folder_id" is null');
	expect(rendered.sql).toContain('"updated_at" >=');
	expect(rendered.sql).toContain('"updated_at" <');
	expect(rendered.params).toContain(query.q);
});

test("listing sort includes deterministic ID order and fingerprints include scope and filters", () => {
	const query = documentListQuerySchema.parse({});
	expect(
		documentListOrder(query).map((order) => dialect.sqlToQuery(order).sql),
	).toEqual(['"documents"."updated_at" desc', '"documents"."id" desc']);
	const baseline = documentListFingerprint(query, { workspace: first });
	for (const update of [
		{ q: "test" },
		{ rootOnly: true },
		{ tagIds: [first] },
		{ tagMatch: "any" as const },
		{ categoryId: first },
		{ folderId: first },
		{ sortOrder: "asc" as const },
		{ page: 2 },
		{ limit: 1 },
		{ updatedFrom: "2026-01-01T00:00:00Z" },
	])
		expect(
			documentListFingerprint({ ...query, ...update }, { workspace: first }),
		).not.toBe(baseline);
	expect(documentListFingerprint(query, { workspace: second })).not.toBe(
		baseline,
	);
});

test("previews retain Unicode code points and links do not trust a request host", () => {
	expect(documentPreview("😀".repeat(201))).toBe("😀".repeat(200));
	expect(documentPreview(null)).toBe("");
	expect(documentLocation(first)).toEqual({
		workspaceId: null,
		workspaceSlug: null,
		url: `/docs/${first}`,
	});
	expect(
		documentLocation(first, second, "https://docs.example.test/base/"),
	).toEqual({
		workspaceId: second,
		workspaceSlug: null,
		url: `https://docs.example.test/base/docs/${first}`,
	});
});
