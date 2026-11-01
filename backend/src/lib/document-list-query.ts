import { documents } from "@hiai-docs/db/schema";
import { asc, desc, eq, gte, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import {
	effectiveDocumentCategoryCondition,
	tenantOwnerSql,
} from "./content-access";
import type { TenantContext } from "./with-tenant";

const uuid = z.string().uuid();
const csvIds = z.preprocess(
	(value) =>
		typeof value === "string" ? value.split(",").map((id) => id.trim()) : value,
	z
		.array(uuid)
		.min(1)
		.max(100)
		.transform((ids) => [...new Set(ids)].sort()),
);
const booleanQuery = z.preprocess(
	(value) => (value === "true" ? true : value === "false" ? false : value),
	z.boolean(),
);
export const documentListQueryFields = {
	visibility: z.enum(["private", "shared", "public"]).optional(),
	folderId: uuid.optional(),
	categoryId: uuid.optional(),
	rootOnly: booleanQuery.default(false),
	tag: uuid.optional(),
	tagIds: csvIds.optional(),
	tagMatch: z.enum(["all", "any"]).default("all"),
	q: z.string().max(2000).optional(),
	updatedFrom: z.string().datetime({ offset: true }).optional(),
	updatedTo: z.string().datetime({ offset: true }).optional(),
	sortBy: z.enum(["updatedAt", "createdAt", "title"]).default("updatedAt"),
	sortOrder: z.enum(["asc", "desc"]).default("desc"),
	page: z.coerce.number().int().min(1).default(1),
	limit: z.coerce.number().int().min(1).max(1000).default(20),
};
export function validateDocumentListQuery(
	value: {
		rootOnly: boolean;
		folderId?: string;
		tag?: string;
		tagIds?: string[];
		updatedFrom?: string;
		updatedTo?: string;
	},
	ctx: z.RefinementCtx,
) {
	if (value.rootOnly && value.folderId)
		ctx.addIssue({
			code: "custom",
			path: ["rootOnly"],
			message: "rootOnly and folderId cannot be combined",
		});
	if (value.tag && value.tagIds)
		ctx.addIssue({
			code: "custom",
			path: ["tagIds"],
			message: "tag and tagIds cannot be combined",
		});
	if (
		value.updatedFrom &&
		value.updatedTo &&
		Date.parse(value.updatedFrom) >= Date.parse(value.updatedTo)
	)
		ctx.addIssue({
			code: "custom",
			path: ["updatedTo"],
			message: "updatedTo must be after updatedFrom",
		});
}
export const documentListQuerySchema = z
	.object(documentListQueryFields)
	.superRefine(validateDocumentListQuery);
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

/** Authorization predicates are added by the route; these predicates can only narrow them. */
export function documentListConditions(
	ctx: TenantContext,
	query: DocumentListQuery,
): SQL[] {
	const conditions: SQL[] = [];
	if (query.visibility)
		conditions.push(eq(documents.visibility, query.visibility));
	if (query.folderId) conditions.push(eq(documents.folderId, query.folderId));
	if (query.rootOnly) conditions.push(isNull(documents.folderId));
	if (query.categoryId)
		conditions.push(
			effectiveDocumentCategoryCondition(
				documents.categoryId,
				documents.folderId,
				ctx,
				query.categoryId,
			),
		);
	if (query.updatedFrom)
		conditions.push(gte(documents.updatedAt, new Date(query.updatedFrom)));
	if (query.updatedTo)
		conditions.push(lt(documents.updatedAt, new Date(query.updatedTo)));
	if (query.q)
		conditions.push(
			sql`(position(lower(${query.q}) in lower(${documents.title})) > 0 OR position(lower(${query.q}) in lower(coalesce(${documents.content}, ''))) > 0)`,
		);
	const ids = query.tagIds ?? (query.tag ? [query.tag] : []);
	const tagConditions = ids.map(
		(id) =>
			sql`EXISTS (SELECT 1 FROM document_tags list_dt JOIN tags list_tag ON list_tag.id = list_dt.tag_id WHERE list_dt.document_id = ${documents.id} AND list_dt.tag_id = ${id} AND ${tenantOwnerSql("list_tag", ctx)})`,
	);
	if (tagConditions.length) {
		if (query.tagMatch === "any")
			conditions.push(or(...tagConditions) ?? sql`false`);
		else conditions.push(...tagConditions);
	}
	return conditions;
}

export function documentListOrder(
	query: Pick<DocumentListQuery, "sortBy" | "sortOrder">,
): SQL[] {
	const value =
		query.sortBy === "title"
			? sql`lower(${documents.title})`
			: query.sortBy === "createdAt"
				? documents.createdAt
				: documents.updatedAt;
	const direction = query.sortOrder === "asc" ? asc : desc;
	return [direction(value), direction(documents.id)];
}

/** Every query field and caller identity participates; callers retain the existing invalidation prefix. */
export function documentListFingerprint(
	query: DocumentListQuery,
	scope: unknown,
): string {
	return new Bun.CryptoHasher("sha256")
		.update(JSON.stringify({ query, scope }))
		.digest("hex");
}
