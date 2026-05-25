import { Elysia } from "elysia";
import { eq, and, count, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db";
import { documents, versions, documentTags, tags } from "@hiai-docs/db/schema";
import { logger } from "../../lib/logger";
import { enqueueEmbedding } from "../../lib/embedding-queue";
import { getSessionUserId } from "../../lib/auth-helpers";

const createDocumentSchema = z.object({
  title: z.string().min(1).max(500).default("Untitled"),
  content: z.string().optional(),
  folderId: z.string().uuid().optional(),
});

const updateDocumentSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().optional(),
  contentTipex: z.unknown().optional(),
  metadata: z.unknown().optional(),
  folderId: z.string().uuid().nullable().optional(),
});

const listQuerySchema = z.object({
  folderId: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const documentRoutes = new Elysia({ prefix: "/api" })
  // GET /api/documents — List documents with pagination
  .get("/documents", async ({ query, set, request }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      set.status = 400;
      return { error: "Invalid query", details: parsed.error.flatten() };
    }
    const { folderId, tag, page, limit } = parsed.data;
    const offset = (page - 1) * limit;
    try {
      const conditions = [eq(documents.ownerId, userId)];
      if (folderId) conditions.push(eq(documents.folderId, folderId));

      if (tag) {
        const [countResult, rows] = await Promise.all([
          db.select({ total: count() }).from(documents)
            .innerJoin(documentTags, eq(documents.id, documentTags.documentId))
            .where(and(eq(documentTags.tagId, tag), ...conditions)),
          db.select({ id: documents.id, title: documents.title, content: sql<string>`LEFT(${documents.content}, 200)`.as('content'), folderId: documents.folderId, createdAt: documents.createdAt, updatedAt: documents.updatedAt })
            .from(documents)
            .innerJoin(documentTags, eq(documents.id, documentTags.documentId))
            .where(and(eq(documentTags.tagId, tag), ...conditions))
            .orderBy(desc(documents.updatedAt)).limit(limit).offset(offset),
        ]);
        return { items: rows, total: countResult[0]?.total ?? 0, page, limit };
      }

      const [countResult, rows] = await Promise.all([
        db.select({ total: count() }).from(documents).where(and(...conditions)),
        db.select({ id: documents.id, title: documents.title, content: sql<string>`LEFT(${documents.content}, 200)`.as('content'), folderId: documents.folderId, createdAt: documents.createdAt, updatedAt: documents.updatedAt })
          .from(documents).where(and(...conditions))
          .orderBy(desc(documents.updatedAt)).limit(limit).offset(offset),
      ]);
      return { items: rows, total: countResult[0]?.total ?? 0, page, limit };
    } catch (err) {
      logger.error({ err }, "Failed to list documents");
      set.status = 500;
      return { error: "Failed to list documents" };
    }
  })

  // POST /api/documents — Create document + initial version
  .post("/documents", async ({ request, set }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    const body = createDocumentSchema.safeParse(await request.json());
    if (!body.success) {
      set.status = 400;
      return { error: "Invalid input", details: body.error.flatten() };
    }
    try {
      const [created] = await db.insert(documents).values({
        ownerId: userId,
        title: body.data.title,
        content: body.data.content ?? "",
        folderId: body.data.folderId ?? null,
      }).returning();
      if (!created) { set.status = 500; return { error: "Failed to create document" }; }

      await db.insert(versions).values({
        documentId: created.id,
        content: body.data.content ?? "",
        createdBy: userId,
      });

      enqueueEmbedding(created.id);
      set.status = 201;
      return created;
    } catch (err) {
      logger.error({ err }, "Failed to create document");
      set.status = 500;
      return { error: "Failed to create document" };
    }
  })

  // GET /api/documents/:id — Get document with tags
  .get("/documents/:id", async ({ params, set, request }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    try {
      const rows = await db.select({
        id: documents.id, ownerId: documents.ownerId, folderId: documents.folderId,
        title: documents.title, content: documents.content, contentTipex: documents.contentTipex,
        metadata: documents.metadata, createdAt: documents.createdAt, updatedAt: documents.updatedAt,
      }).from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
        .limit(1);

      const doc = rows[0];
      if (!doc) { set.status = 404; return { error: "Document not found" }; }

      const docTags = await db.select({ id: tags.id, name: tags.name, color: tags.color })
        .from(tags)
        .innerJoin(documentTags, eq(tags.id, documentTags.tagId))
        .where(eq(documentTags.documentId, doc.id));

      return { ...doc, tags: docTags };
    } catch (err) {
      logger.error({ err }, "Failed to get document");
      set.status = 500;
      return { error: "Failed to get document" };
    }
  })

  // PATCH /api/documents/:id — Update document, save version before
  .patch("/documents/:id", async ({ params, request, set }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    const body = updateDocumentSchema.safeParse(await request.json());
    if (!body.success) {
      set.status = 400;
      return { error: "Invalid input", details: body.error.flatten() };
    }
    if (!body.data.title && body.data.content === undefined && body.data.contentTipex === undefined && body.data.metadata === undefined && body.data.folderId === undefined) {
      set.status = 400;
      return { error: "At least one field is required" };
    }
    try {
      const existing = await db.select({ id: documents.id, content: documents.content, contentTipex: documents.contentTipex })
        .from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
        .limit(1);
      if (existing.length === 0) { set.status = 404; return { error: "Document not found" }; }

      await db.insert(versions).values({
        documentId: params.id,
        content: existing[0]!.content ?? "",
        contentTipex: existing[0]!.contentTipex,
        createdBy: userId,
      });

      const [updated] = await db.update(documents).set({
        ...(body.data.title !== undefined && { title: body.data.title }),
        ...(body.data.content !== undefined && { content: body.data.content }),
        ...(body.data.contentTipex !== undefined && { contentTipex: body.data.contentTipex }),
        ...(body.data.metadata !== undefined && { metadata: body.data.metadata }),
        ...(body.data.folderId !== undefined && { folderId: body.data.folderId }),
        updatedAt: new Date(),
      }).where(and(eq(documents.id, params.id), eq(documents.ownerId, userId))).returning();

      if (body.data.content !== undefined || body.data.title !== undefined) {
        enqueueEmbedding(params.id);
      }
      return updated;
    } catch (err) {
      logger.error({ err }, "Failed to update document");
      set.status = 500;
      return { error: "Failed to update document" };
    }
  })

  // DELETE /api/documents/:id — Delete document (cascade via FK)
  .delete("/documents/:id", async ({ params, set, request }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    try {
      const existing = await db.select({ id: documents.id }).from(documents)
        .where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)))
        .limit(1);
      if (existing.length === 0) { set.status = 404; return { error: "Document not found" }; }
      await db.delete(documents).where(and(eq(documents.id, params.id), eq(documents.ownerId, userId)));
      return { success: true };
    } catch (err) {
      logger.error({ err }, "Failed to delete document");
      set.status = 500;
      return { error: "Failed to delete document" };
    }
  });
