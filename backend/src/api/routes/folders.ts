import { Elysia } from "elysia";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../lib/db";
import { folders } from "@hiai-docs/db/schema";
import { logger } from "../../lib/logger";
import { getSessionUserId } from "../../lib/auth-helpers";

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().optional(),
});

const updateFolderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

export const folderRoutes = new Elysia({ prefix: "/api/folders" })
  .get("/", async ({ query, set, request }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    try {
      const conditions = [eq(folders.ownerId, userId)];
      if (query.parentId) {
        conditions.push(eq(folders.parentId, query.parentId));
      } else {
        conditions.push(isNull(folders.parentId));
      }
      const rows = await db.select().from(folders).where(and(...conditions)).orderBy(folders.name);
      return rows;
    } catch (err) {
      logger.error({ err }, "Failed to list folders");
      set.status = 500;
      return { error: "Failed to list folders" };
    }
  })
  .post("/", async ({ request, set }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    const parsed = createFolderSchema.safeParse(await request.json());
    if (!parsed.success) {
      set.status = 400;
      return { error: "Invalid input", details: parsed.error.flatten() };
    }
    try {
      if (parsed.data.parentId) {
        const parent = await db.select({ id: folders.id }).from(folders)
          .where(and(eq(folders.id, parsed.data.parentId), eq(folders.ownerId, userId))).limit(1);
        if (parent.length === 0) { set.status = 404; return { error: "Parent folder not found" }; }
      }
      const [created] = await db.insert(folders).values({
        ownerId: userId, name: parsed.data.name, parentId: parsed.data.parentId ?? null,
      }).returning();
      set.status = 201;
      return created;
    } catch (err) {
      logger.error({ err }, "Failed to create folder");
      set.status = 500;
      return { error: "Failed to create folder" };
    }
  })
  .patch("/:id", async ({ params, request, set }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    const parsed = updateFolderSchema.safeParse(await request.json());
    if (!parsed.success) {
      set.status = 400;
      return { error: "Invalid input", details: parsed.error.flatten() };
    }
    if (parsed.data.name === undefined && parsed.data.parentId === undefined) {
      set.status = 400;
      return { error: "At least one field (name or parentId) is required" };
    }
    try {
      if (parsed.data.parentId) {
        if (parsed.data.parentId === params.id) {
          set.status = 400;
          return { error: "Folder cannot be its own parent" };
        }
        const parent = await db.select({ id: folders.id }).from(folders)
          .where(and(eq(folders.id, parsed.data.parentId), eq(folders.ownerId, userId))).limit(1);
        if (parent.length === 0) { set.status = 404; return { error: "Parent folder not found" }; }
      }
      const [updated] = await db.update(folders).set({
        ...(parsed.data.name !== undefined && { name: parsed.data.name }),
        ...(parsed.data.parentId !== undefined && { parentId: parsed.data.parentId }),
        updatedAt: new Date(),
      }).where(and(eq(folders.id, params.id), eq(folders.ownerId, userId))).returning();
      if (!updated) { set.status = 404; return { error: "Folder not found" }; }
      return updated;
    } catch (err) {
      logger.error({ err }, "Failed to update folder");
      set.status = 500;
      return { error: "Failed to update folder" };
    }
  })
  .delete("/:id", async ({ params, set, request }) => {
    const userId = await getSessionUserId(request.headers);
    if (!userId) { set.status = 401; return { error: "Unauthorized" }; }
    try {
      const existing = await db.select({ id: folders.id }).from(folders)
        .where(and(eq(folders.id, params.id), eq(folders.ownerId, userId))).limit(1);
      if (existing.length === 0) { set.status = 404; return { error: "Folder not found" }; }
      await db.delete(folders).where(and(eq(folders.id, params.id), eq(folders.ownerId, userId)));
      return { success: true };
    } catch (err) {
      logger.error({ err }, "Failed to delete folder");
      set.status = 500;
      return { error: "Failed to delete folder" };
    }
  });
