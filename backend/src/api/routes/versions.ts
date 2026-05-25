import { Elysia } from "elysia";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../../lib/db";
import { versions, documents } from "@hiai-docs/db/schema";
import { logger } from "../../lib/logger";
import { getSessionUserId } from "../../lib/auth-helpers";

export const versionRoutes = new Elysia({ prefix: "/api/documents/:id/versions" })
  // GET /api/documents/:id/versions — list versions
  .get("/", async ({ params, set, request }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    try {
      const doc = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
        .limit(1);

      if (doc.length === 0) {
        set.status = 404;
        return { error: "Document not found" };
      }

      const rows = await db
        .select({
          id: versions.id,
          documentId: versions.documentId,
          content: versions.content,
          contentTipex: versions.contentTipex,
          createdBy: versions.createdBy,
          createdAt: versions.createdAt,
        })
        .from(versions)
        .where(eq(versions.documentId, params.id))
        .orderBy(desc(versions.createdAt));

      return rows;
    } catch (err) {
      logger.error({ err, docId: params.id }, "Failed to list versions");
      set.status = 500;
      return { error: "Failed to list versions" };
    }
  })

  // GET /api/documents/:id/versions/:vid — get specific version
  .get("/:vid", async ({ params, set, request }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    try {
      const doc = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
        .limit(1);

      if (doc.length === 0) {
        set.status = 404;
        return { error: "Document not found" };
      }

      const rows = await db
        .select({
          id: versions.id,
          documentId: versions.documentId,
          content: versions.content,
          contentTipex: versions.contentTipex,
          createdBy: versions.createdBy,
          createdAt: versions.createdAt,
        })
        .from(versions)
        .where(and(eq(versions.id, params.vid), eq(versions.documentId, params.id)))
        .limit(1);

      if (rows.length === 0) {
        set.status = 404;
        return { error: "Version not found" };
      }

      return rows[0];
    } catch (err) {
      logger.error({ err, docId: params.id, vid: params.vid }, "Failed to get version");
      set.status = 500;
      return { error: "Failed to get version" };
    }
  });
