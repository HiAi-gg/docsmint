import { documents, folders, versions } from "@hiai-docs/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { z } from "zod";
import {
	canAccessContent,
	effectiveDocumentCategory,
	isAuthorizedCategory,
	resolveContentAccess,
} from "../../lib/content-access";
import { logger } from "../../lib/logger";
import { enqueueReembed } from "../../lib/reembed";
import { withTenant } from "../../lib/with-tenant";
import { rateLimitHeaders, writeRateLimiter } from "../middleware/rate-limit";

async function authorizeVersionDocument(
	request: Request,
	documentId: string,
	action: "read" | "edit",
) {
	const access = await resolveContentAccess(request);
	if (access.ctx.role === "none" || !canAccessContent(access, action)) {
		return { access, authorized: false as const, row: null };
	}
	const row = await withTenant(access.ctx, async (tx) => {
		const [document] = await tx
			.select({
				id: documents.id,
				categoryId: documents.categoryId,
				folderCategoryId: folders.categoryId,
			})
			.from(documents)
			.leftJoin(folders, eq(folders.id, documents.folderId))
			.where(
				and(eq(documents.id, documentId), eq(documents.ownerId, access.userId)),
			)
			.limit(1);
		return document ?? null;
	});
	return {
		access,
		row,
		authorized:
			!!row && isAuthorizedCategory(access, effectiveDocumentCategory(row)),
	};
}

/**
 * Whole-file line-based diff. For two strings `a` and `b`, returns a
 * sequence of "hunks" — runs of equal, added, or removed lines — that
 * the frontend can render as a unified diff.
 *
 * Implementation: classic LCS dynamic programming (O(n*m) time/space,
 * acceptable for documents up to a few thousand lines). Walk the LCS
 * table from (n,m) back to (0,0) to extract the edit script, then
 * reverse and group consecutive same-type operations into hunks.
 *
 * Lines are split on `\n` with no string trim, so trailing whitespace
 * and blank lines are preserved as-is. Empty inputs produce a single
 * "unchanged" hunk with zero lines rather than an empty array, keeping
 * the response shape predictable for the renderer.
 */
type DiffHunk = { type: "add" | "remove" | "unchanged"; lines: string[] };

function diffLines(a: string, b: string): DiffHunk[] {
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	const n = aLines.length;
	const m = bLines.length;

	// Build LCS length table. lcs[i][j] = LCS length of aLines[0..i) and bLines[0..j).
	const lcs: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = 1; i <= n; i++) {
		const aLine = aLines[i - 1];
		const row = lcs[i];
		const prev = lcs[i - 1];
		if (!row || !prev) continue;
		for (let j = 1; j <= m; j++) {
			const left = row[j - 1] ?? 0;
			const up = prev[j] ?? 0;
			const diag = prev[j - 1] ?? 0;
			row[j] = aLine === bLines[j - 1] ? diag + 1 : Math.max(up, left);
		}
	}

	// Walk back to extract the edit script.
	const ops: DiffHunk["type"][] = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (aLines[i - 1] === bLines[j - 1]) {
			ops.push("unchanged");
			i--;
			j--;
		} else if ((lcs[i - 1]?.[j] ?? 0) >= (lcs[i]?.[j - 1] ?? 0)) {
			ops.push("remove");
			i--;
		} else {
			ops.push("add");
			j--;
		}
	}
	while (i > 0) {
		ops.push("remove");
		i--;
	}
	while (j > 0) {
		ops.push("add");
		j--;
	}
	ops.reverse();

	// Group consecutive same-type ops into hunks and pull the actual line
	// text for each position.
	const hunks: DiffHunk[] = [];
	let aIdx = 0;
	let bIdx = 0;
	let cursor = 0;
	while (cursor < ops.length) {
		const type = ops[cursor];
		if (!type) break;
		const lines: string[] = [];
		while (cursor < ops.length && ops[cursor] === type) {
			if (type === "remove") {
				lines.push(aLines[aIdx] ?? "");
				aIdx++;
			} else if (type === "add") {
				lines.push(bLines[bIdx] ?? "");
				bIdx++;
			} else {
				lines.push(aLines[aIdx] ?? "");
				aIdx++;
				bIdx++;
			}
			cursor++;
		}
		hunks.push({ type, lines });
	}

	if (hunks.length === 0) {
		return [{ type: "unchanged", lines: [] }];
	}
	return hunks;
}

function summarize(hunks: DiffHunk[]): {
	added: number;
	removed: number;
	modified: number;
} {
	let added = 0;
	let removed = 0;
	let modified = 0;
	for (const h of hunks) {
		if (h.type === "add") added += h.lines.length;
		else if (h.type === "remove") removed += h.lines.length;
	}
	// A "modified" line is a remove+add pair sitting in adjacent hunks
	// at the same position in the edit script — either [remove, add]
	// (the conventional order from the LCS back-walk) or [add, remove]
	// (which appears when the back-walk breaks ties in the other
	// direction). Both are surfaced to the renderer as a single line
	// that changed, not as a separate insertion and deletion.
	for (let k = 0; k < hunks.length - 1; k++) {
		const a = hunks[k];
		const b = hunks[k + 1];
		if (!a || !b) continue;
		if (
			(a.type === "remove" && b.type === "add") ||
			(a.type === "add" && b.type === "remove")
		) {
			modified += Math.min(a.lines.length, b.lines.length);
		}
	}
	return { added, removed, modified };
}

function getClientIp(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

const listQuerySchema = z.object({
	onlySnapshots: z
		.union([z.literal("true"), z.literal("false")])
		.optional()
		.transform((v) => v === "true"),
	limit: z.coerce.number().int().min(1).max(500).default(100),
});

const createSnapshotSchema = z.object({
	label: z.string().min(1).max(200),
	description: z.string().max(1000).optional(),
});

export const versionRoutes = new Elysia({
	prefix: "/api/documents/:id/versions",
})
	// GET /api/documents/:id/versions — list versions
	.get("/", async ({ params, query, set, request }) => {
		const ip = getClientIp(request);
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		const authorization = await authorizeVersionDocument(
			request,
			params.id,
			"read",
		);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.row ? 403 : 404;
			return { error: authorization.row ? "Forbidden" : "Document not found" };
		}
		const userId = ctx.userId;

		const parsed = listQuerySchema.safeParse(query);
		if (!parsed.success) {
			set.status = 400;
			return { error: "Invalid query", details: parsed.error.flatten() };
		}
		const { onlySnapshots, limit } = parsed.data;

		try {
			const rows = await withTenant(ctx, async (tx) => {
				const doc = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);

				if (doc.length === 0) {
					return null;
				}

				const whereClause = onlySnapshots
					? and(
							eq(versions.documentId, params.id),
							eq(versions.isSnapshot, true),
						)
					: eq(versions.documentId, params.id);

				return tx
					.select({
						id: versions.id,
						documentId: versions.documentId,
						content: versions.content,
						contentJson: versions.contentJson,
						createdBy: versions.createdBy,
						createdAt: versions.createdAt,
						label: versions.label,
						description: versions.description,
						isSnapshot: versions.isSnapshot,
						restoredFrom: versions.restoredFrom,
					})
					.from(versions)
					.where(whereClause)
					.orderBy(desc(versions.createdAt))
					.limit(limit);
			});

			if (!rows) {
				set.status = 404;
				return { error: "Document not found" };
			}
			return rows;
		} catch (err) {
			logger.error({ err, docId: params.id }, "Failed to list versions");
			set.status = 500;
			return { error: "Failed to list versions" };
		}
	})

	// POST /api/documents/:id/versions — create a named snapshot of the
	// current document content. Snapshots are never auto-pruned, while
	// ordinary auto-saved versions are subject to the retention policy.
	.post("/", async ({ params, request, set }) => {
		const ip = getClientIp(request);
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		const authorization = await authorizeVersionDocument(
			request,
			params.id,
			"edit",
		);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.row ? 403 : 404;
			return { error: authorization.row ? "Forbidden" : "Document not found" };
		}
		const userId = ctx.userId;

		const body = createSnapshotSchema.safeParse(await request.json());
		if (!body.success) {
			set.status = 400;
			return { error: "Invalid input", details: body.error.flatten() };
		}

		try {
			const snapshot = await withTenant(ctx, async (tx) => {
				const docRows = await tx
					.select({
						id: documents.id,
						content: documents.content,
						contentJson: documents.contentJson,
					})
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);

				if (docRows.length === 0) {
					return null;
				}
				const doc = docRows[0];

				const [row] = await tx
					.insert(versions)
					.values({
						documentId: doc?.id as string,
						content: doc?.content ?? "",
						contentJson: doc?.contentJson,
						createdBy: userId,
						label: body.data.label,
						description: body.data.description,
						isSnapshot: true,
					})
					.returning();
				return row ?? null;
			});

			if (!snapshot) {
				set.status = 404;
				return { error: "Document not found" };
			}
			set.status = 201;
			return snapshot;
		} catch (err) {
			logger.error({ err, docId: params.id }, "Failed to create snapshot");
			set.status = 500;
			return { error: "Failed to create snapshot" };
		}
	})

	// GET /api/documents/:id/versions/:vid — get specific version
	.get("/:vid", async ({ params, set, request }) => {
		const authorization = await authorizeVersionDocument(
			request,
			params.id,
			"read",
		);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.row ? 403 : 404;
			return { error: authorization.row ? "Forbidden" : "Document not found" };
		}
		const userId = ctx.userId;
		try {
			const result = await withTenant(ctx, async (tx) => {
				const doc = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);

				if (doc.length === 0) {
					return { docMissing: true as const };
				}

				const rows = await tx
					.select({
						id: versions.id,
						documentId: versions.documentId,
						content: versions.content,
						contentJson: versions.contentJson,
						createdBy: versions.createdBy,
						createdAt: versions.createdAt,
						label: versions.label,
						description: versions.description,
						isSnapshot: versions.isSnapshot,
						restoredFrom: versions.restoredFrom,
					})
					.from(versions)
					.where(
						and(
							eq(versions.id, params.vid),
							eq(versions.documentId, params.id),
						),
					)
					.limit(1);
				return { row: rows[0] ?? null };
			});

			if ("docMissing" in result) {
				set.status = 404;
				return { error: "Document not found" };
			}
			if (!result.row) {
				set.status = 404;
				return { error: "Version not found" };
			}
			return result.row;
		} catch (err) {
			logger.error(
				{ err, docId: params.id, vid: params.vid },
				"Failed to get version",
			);
			set.status = 500;
			return { error: "Failed to get version" };
		}
	})

	// POST /api/documents/:id/versions/:vid/restore — restore a prior
	// version to the live document. The current content is first saved
	// as a fresh auto-version (auto-backup), so the restore itself is
	// always reversible from the version history.
	.post("/:vid/restore", async ({ params, set, request }) => {
		const ip = getClientIp(request);
		const rl = await writeRateLimiter(ip, request);
		if (!rl.allowed) {
			set.status = 429;
			set.headers = rateLimitHeaders(0, rl.retryAfter);
			return { error: "Too many requests" };
		}
		set.headers = rateLimitHeaders(rl.remaining);

		const authorization = await authorizeVersionDocument(
			request,
			params.id,
			"edit",
		);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.row ? 403 : 404;
			return { error: authorization.row ? "Forbidden" : "Document not found" };
		}
		const userId = ctx.userId;
		try {
			const updated = await withTenant(ctx, async (tx) => {
				const docRows = await tx
					.select({
						id: documents.id,
						content: documents.content,
						contentJson: documents.contentJson,
					})
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);

				if (docRows.length === 0) {
					return null;
				}
				const doc = docRows[0];

				const versionRows = await tx
					.select({
						id: versions.id,
						content: versions.content,
						contentJson: versions.contentJson,
					})
					.from(versions)
					.where(
						and(
							eq(versions.id, params.vid),
							eq(versions.documentId, params.id),
						),
					)
					.limit(1);

				const target = versionRows[0];
				if (!target) {
					return null;
				}

				// 1. Auto-backup current content as a fresh version BEFORE
				//    overwriting. This makes the restore reversible: the
				//    user can restore the pre-restore state by restoring
				//    this auto-backup later.
				const docId = doc?.id as string;
				await tx.insert(versions).values({
					documentId: docId,
					content: doc?.content ?? "",
					contentJson: doc?.contentJson,
					createdBy: userId,
				});

				// 2. Overwrite the live document with the target version's
				//    content + JSON view, then 3. record a marker version
				//    pointing back at the source of the restore.
				const [row] = await tx
					.update(documents)
					.set({
						content: target.content,
						contentJson: target.contentJson,
						updatedAt: new Date(),
					})
					.where(and(eq(documents.id, docId), eq(documents.ownerId, userId)))
					.returning();

				await tx.insert(versions).values({
					documentId: docId,
					content: target.content,
					contentJson: target.contentJson,
					createdBy: userId,
					restoredFrom: target.id,
				});

				return row ?? null;
			});

			if (!updated) {
				set.status = 404;
				return { error: "Document not found" };
			}
			void enqueueReembed([params.id]).catch((err) =>
				logger.warn({ err, documentId: params.id }, "Pipeline enqueue failed"),
			);
			return updated;
		} catch (err) {
			logger.error(
				{ err, docId: params.id, vid: params.vid },
				"Failed to restore version",
			);
			set.status = 500;
			return { error: "Failed to restore version" };
		}
	})

	// GET /api/documents/:id/versions/diff?from=<vid>&to=<vid> — line-based
	// diff between two versions. Both versions must belong to the same
	// document, and the document must be owned by the caller. The order
	// of `from` vs `to` matters: `from` is the "before" and `to` is the
	// "after" in the returned hunks.
	//
	// Note: We use a query-string pair (`?from=&to=`) instead of nested
	// path parameters like `/:from/diff/:to`, because Elysia's router
	// (memoirist) requires consistent parameter names along the same
	// path branch — `/:from` would collide with the `:vid` parameter on
	// the sibling `/:vid` and `/:vid/restore` routes.
	.get("/diff", async ({ params, query, set, request }) => {
		const authorization = await authorizeVersionDocument(
			request,
			params.id,
			"read",
		);
		const ctx = authorization.access.ctx;
		if (ctx.role === "none") {
			set.status = 401;
			return { error: "Unauthorized" };
		}
		if (!authorization.authorized) {
			set.status = authorization.row ? 403 : 404;
			return { error: authorization.row ? "Forbidden" : "Document not found" };
		}
		const userId = ctx.userId;
		const fromId = query.from;
		const toId = query.to;
		if (typeof fromId !== "string" || typeof toId !== "string") {
			set.status = 400;
			return { error: "Missing required query params: from, to" };
		}
		try {
			const diff = await withTenant(ctx, async (tx) => {
				const doc = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(eq(documents.id, params.id), eq(documents.ownerId, userId)),
					)
					.limit(1);

				if (doc.length === 0) {
					return null;
				}

				const bothVersions = await tx
					.select({
						id: versions.id,
						label: versions.label,
						createdAt: versions.createdAt,
						content: versions.content,
					})
					.from(versions)
					.where(eq(versions.documentId, params.id));

				const v1 = bothVersions.find((v) => v.id === fromId);
				const v2 = bothVersions.find((v) => v.id === toId);
				if (!v1 || !v2) {
					return null;
				}

				const hunks = diffLines(v1.content, v2.content);
				const changes = summarize(hunks);

				return {
					v1: { id: v1.id, label: v1.label, createdAt: v1.createdAt },
					v2: { id: v2.id, label: v2.label, createdAt: v2.createdAt },
					changes,
					hunks,
				};
			});

			if (!diff) {
				set.status = 404;
				return { error: "Document not found" };
			}
			return diff;
		} catch (err) {
			logger.error(
				{ err, docId: params.id, from: fromId, to: toId },
				"Failed to diff versions",
			);
			set.status = 500;
			return { error: "Failed to diff versions" };
		}
	});
