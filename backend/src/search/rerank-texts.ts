import { documents } from "@hiai-docs/db/schema";
import type { TenantContext } from "@hiai-docs/db/with-tenant";
import { and, inArray, isNull } from "drizzle-orm";
import { config } from "../lib/config";
import { withTenant } from "../lib/with-tenant";
import { normalizeRerankText } from "./rerank";

export async function loadRerankTexts(
	ctx: TenantContext,
	documentIds: string[],
	maxChars = config.SEARCH_RERANK_MAX_CHARS,
): Promise<Map<string, string>> {
	const texts = new Map<string, string>();
	if (documentIds.length === 0) return texts;
	const rows = await withTenant(ctx, async (tx) =>
		tx
			.select({
				id: documents.id,
				title: documents.title,
				content: documents.content,
			})
			.from(documents)
			.where(
				and(isNull(documents.deletedAt), inArray(documents.id, documentIds)),
			),
	);
	for (const row of rows) {
		texts.set(
			row.id,
			normalizeRerankText(row.title, row.content ?? "", maxChars),
		);
	}
	return texts;
}
