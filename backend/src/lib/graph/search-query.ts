import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { sql } from "drizzle-orm";
import { normalizeQuery } from "../../search/query-analyzer";
import { tenantOwnerSql } from "../content-access";

/** Apply the normal search lexical primitives only to authorized graph neighbors. */
export function graphSearchDocumentQuery(
	ctx: TenantContext,
	documentIds: string[],
	query?: string,
) {
	const normalized = normalizeQuery(query ?? "");
	const english = sql`websearch_to_tsquery('english', ${normalized})`;
	const simple = sql`websearch_to_tsquery('simple', ${normalized})`;
	const exact = sql`lower(trim(d.title)) = lower(${normalized})`;
	const match = normalized
		? sql`AND (${exact} OR d.search_vector @@ ${english} OR d.search_vector_simple @@ ${simple})`
		: sql``;
	const order = normalized
		? sql`${exact} DESC, GREATEST(ts_rank(d.search_vector, ${english}), ts_rank(d.search_vector_simple, ${simple})) DESC,`
		: sql``;
	const allowed = documentIds.length
		? sql`d.id IN (${sql.join(
				documentIds.map((id) => sql`${id}`),
				sql`, `,
			)})`
		: sql`false`;
	return sql`
  SELECT d.id, d.title, d.content
  FROM documents d
  WHERE ${tenantOwnerSql("d", ctx)}
   AND d.deleted_at IS NULL
   AND ${allowed}
   ${match}
  ORDER BY ${order} d.id ASC
 `;
}
