/**
 * # Drizzle ORM RLS Query Examples
 *
 * This file demonstrates how PostgreSQL Row-Level Security (RLS) integrates
 * transparently with Drizzle ORM queries. Every database connection in this
 * project has RLS enabled on tenant-scoped tables. Once the middleware sets
 * `app.current_user_id` and `app.user_role` session parameters (via
 * `SET LOCAL`), all subsequent Drizzle queries **automatically** respect the
 * caller's tenant boundary — no `.where()` filters needed.
 *
 * ## How RLS works
 *
 * Each tenant-scoped table has a **policy** that injects a `WHERE` clause on
 * every row access. The policy reads `current_setting('app.current_user_id')`
 * and compares it to the row's `owner_id`:
 *
 * ```sql
 * CREATE POLICY tenant_isolation ON documents
 *   USING (owner_id = current_setting('app.current_user_id')::uuid);
 * ```
 *
 * Child tables (attachments, versions, etc.) use a **subquery policy**:
 *
 * ```sql
 * CREATE POLICY child_tenant_isolation ON attachments
 *   USING (document_id IN (
 *     SELECT id FROM documents
 *     WHERE owner_id = current_setting('app.current_user_id')::uuid
 *   ));
 * ```
 *
 * Admin users bypass RLS entirely via a `BYPASSRLS` attribute or a policy
 * that checks `current_setting('app.user_role')`:
 *
 * ```sql
 * CREATE POLICY admin_all_access ON documents
 *   USING (current_setting('app.user_role') = 'admin');
 * ```
 *
 * ## Key insight
 *
 * Drizzle queries are **unchanged** with RLS. The same `db.select().from(documents)`
 * that returns 5 rows for user A returns 0 rows for user B when neither owns
 * those documents — without any code change. The policy is invisible to the
 * query layer.
 *
 * ## File conventions
 *
 * - All functions are `async function` (no export) — documentation-only.
 * - Imports use relative paths (`./client`, `./schema`).
 * - Each function includes a TSDoc block explaining the RLS behavior.
 *
 * @packageDocumentation
 */

import { db } from "./client";
import {
  documents,
  folders,
  tags,
  categories,
  attachments,
  versions,
  documentTags,
  documentEmbeddings,
  shareLinks,
  guestAccess,
} from "./schema";
import { eq, and, desc, sql } from "drizzle-orm";

// ──────────────────────────────────────────────
//  1.  TENANT-SCOPED TABLES (owner_id)
// ──────────────────────────────────────────────

/**
 * ## Basic document query with RLS
 *
 * The middleware has set `app.current_user_id` to the authenticated user's
 * UUID before this query runs. The RLS policy on `documents` silently appends:
 *
 * ```sql
 * WHERE owner_id = current_setting('app.current_user_id')::uuid
 * ```
 *
 * A user calling `listMyDocuments` sees **only their own documents** — no
 * `where(documents.ownerId, eq(currentUserId))` boilerplate needed.
 *
 * If the session parameter is missing or the user is unauthenticated, RLS
 * returns zero rows (the policy evaluates `NULL = ?` → false).
 */
async function listMyDocuments() {
  return db.select().from(documents).orderBy(desc(documents.createdAt));
}

/**
 * ## Folder query with RLS
 *
 * The `folders` table has the same `owner_id`-based policy. An authenticated
 * user only sees their own folder hierarchy. Note the recursive self-join:
 * RLS applies policy checks on **every** row participating in the query,
 * including the parent folder row in the self-join.
 *
 * ```sql
 * -- Drizzle generates: SELECT ... FROM folders WHERE owner_id = ..._user_id
 * ```
 */
async function getFolderTree() {
  const allFolders = await db.select().from(folders).orderBy(folders.order);
  return buildTree(allFolders);
}

function buildTree(foldersList: (typeof folders.$inferSelect)[]) {
  // In-memory tree building — RLS already filtered rows at the DB level.
  return foldersList;
}

/**
 * ## Tags query with RLS
 *
 * `tags` uses the same `owner_id` policy. The `uniqueIndex("tags_owner_name_idx")`
 * on `(owner_id, name)` enforces per-tenant tag name uniqueness at the
 * database level — two users can each have a tag named "important" without
 * conflict, and RLS prevents cross-tenant visibility.
 */
async function listMyTags() {
  return db.select().from(tags).orderBy(tags.name);
}

/**
 * ## Categories query with RLS
 *
 * Identical pattern — `categories.owner_id` drives the policy. The middleware
 * does not need to distinguish between "document vs folder vs tag vs category"
 * tables; one session parameter applies uniformly.
 */
async function listMyCategories() {
  return db.select().from(categories).orderBy(categories.order);
}

// ──────────────────────────────────────────────
//  2.  CHILD TABLES (indirect tenant via FK)
// ──────────────────────────────────────────────

/**
 * ## Attachments query — RLS through parent
 *
 * `attachments` has **no** `owner_id` column. Its RLS policy uses a subquery:
 *
 * ```sql
 * CREATE POLICY child_tenant_isolation ON attachments
 *   USING (document_id IN (
 *     SELECT id FROM documents
 *     WHERE owner_id = current_setting('app.current_user_id')::uuid
 *   ));
 * ```
 *
 * An authenticated user sees only attachments on documents they own. The
 * subquery is automatically appended as an additional `AND` condition —
 * Drizzle is unaware of it.
 */
async function getAttachmentsForDocument(documentId: string) {
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.documentId, documentId))
    .orderBy(attachments.createdAt);
}

/**
 * ## Versions query — RLS through parent
 *
 * Same subquery policy pattern as attachments, but through `versions.documentId`.
 * Even though the user explicitly filtered by `documentId`, RLS still verifies
 * the user **owns** that document before returning any version rows.
 *
 * If user A passes document B's ID, the policy returns zero rows — the
 * subquery finds no matching document.
 */
async function getVersionHistory(documentId: string) {
  return db
    .select()
    .from(versions)
    .where(eq(versions.documentId, documentId))
    .orderBy(desc(versions.createdAt));
}

/**
 * ## document_tags query — RLS through tag/document
 *
 * The many-to-many junction table participates in RLS via both sides:
 * - If the policy references `documents.owner_id`, the user must own the
 *   document linked by `document_tags.documentId`.
 * - If the policy also references `tags.owner_id`, the user must own the tag.
 *
 * In practice, only one side is needed since both document and tag belong
 * to the same tenant — but the strictest policy wins (AND semantics).
 */
async function getTagsForDocument(documentId: string) {
  return db
    .select()
    .from(documentTags)
    .where(eq(documentTags.documentId, documentId));
}

/**
 * ## document_embeddings query — RLS through parent
 *
 * Embeddings are large (1024-dim vectors). RLS ensures user A cannot
 * extract embedding vectors for user B's documents by guessing document IDs.
 * The HNSW/diskANN index is **not** bypassed by RLS — the vector index scan
 * still happens, then RLS filters the result set.
 */
async function getEmbeddingsForDocument(documentId: string) {
  return db
    .select()
    .from(documentEmbeddings)
    .where(eq(documentEmbeddings.documentId, documentId))
    .orderBy(documentEmbeddings.chunkIndex);
}

// ──────────────────────────────────────────────
//  3.  SHARE LINKS & GUEST ACCESS
// ──────────────────────────────────────────────

/**
 * ## Share links query with RLS
 *
 * `share_links` may have a policy on `created_by` (the user who created the
 * link) so users only see their own share links. An alternative design uses
 * a separate policy that also allows access when the caller's email matches
 * `guest_access.guest_email` — see `guestAccessByEmail` below.
 *
 * This function returns only share links the current user created.
 */
async function listMyShareLinks() {
  return db.select().from(shareLinks).orderBy(desc(shareLinks.createdAt));
}

/**
 * ## Guest access — cross-tenant bypass via email match
 *
 * Guest access requires a policy that allows read when the caller's email
 * (from `current_setting('app.user_email')`) appears in `guest_access` for
 * that share link. This is a **multi-table policy**:
 *
 * ```sql
 * CREATE POLICY guest_read ON documents
 *   USING (
 *     owner_id = current_setting('app.current_user_id')::uuid
 *     OR id IN (
 *       SELECT sl.document_id FROM share_links sl
 *       JOIN guest_access ga ON ga.share_link_id = sl.id
 *       WHERE ga.guest_email = current_setting('app.user_email')
 *     )
 *   );
 * ```
 *
 * When a guest accesses a shared document, Drizzle's `select` returns rows
 * the guest would otherwise never see — RLS transparently allows it.
 */
async function guestAccessByEmail(shareLinkToken: string) {
  // The guest opens a share link by token. If the middleware set
  // app.user_email to the guest's email, RLS permits the join.
  const link = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.token, shareLinkToken))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!link?.documentId) return null;

  // RLS also applies here — but the guest_read policy allows the row
  // because app.user_email matches guest_access.guest_email.
  return db.select().from(documents).where(eq(documents.id, link.documentId)).limit(1);
}

/**
 * ## List guest access grants for my share links
 *
 * Combining `share_links` and `guest_access` in one query. RLS applies to
 * both tables independently:
 * - `share_links` → `created_by = current_user_id`
 * - `guest_access` → subquery through `share_links.created_by`
 */
async function listGuestGrantsForMyLinks() {
  return db
    .select()
    .from(guestAccess)
    .innerJoin(shareLinks, eq(guestAccess.shareLinkId, shareLinks.id))
    .orderBy(desc(guestAccess.grantedAt));
}

// ──────────────────────────────────────────────
//  4.  ADMIN CROSS-TENANT QUERIES
// ──────────────────────────────────────────────

/**
 * ## Admin query — BYPASS RLS
 *
 * When `app.user_role` = `'admin'`, the admin_all_access policy (or
 * PostgreSQL's `BYPASSRLS` attribute) allows the query to return **all**
 * rows regardless of tenant. The same Drizzle code works unchanged:
 *
 * @example
 * ```ts
 * // Admin calls this — sees ALL documents across all tenants
 * const allDocs = await adminListAllDocuments();
 *
 * // Regular user calls this — sees only own documents
 * const myDocs = await adminListAllDocuments();
 * ```
 *
 * The policy dispatch is invisible to the application layer.
 */
async function adminListAllDocuments() {
  return db.select().from(documents).orderBy(desc(documents.createdAt));
}

/**
 * ## Admin aggregated stats across tenants
 *
 * With admin-role session, aggregate queries span all tenants. The same
 * query run by a regular user would only aggregate their own data.
 */
async function adminDocumentStats() {
  return db
    .select({
      totalDocuments: sql<number>`count(*)::int`,
      totalAttachments: sql<number>`sum(
        (SELECT count(*) FROM attachments WHERE attachments.document_id = documents.id)
      )::int`,
      averageVersions: sql<number>`avg(
        (SELECT count(*) FROM versions WHERE versions.document_id = documents.id)
      )::float`,
    })
    .from(documents);
}

/**
 * ## Admin user lookup by email
 *
 * The `users` table typically has no RLS (it's an auth table). This query
 * is unrestricted — the admin can look up any user to investigate tenant
 * misconfiguration or orphaned data.
 */
async function adminFindUserByEmail(email: string) {
  // Uses the Drizzle query client; no RLS on auth tables.
  return db.query.users.findFirst({
    where: (users, { eq }) => eq(users.email, email),
  });
}

// ──────────────────────────────────────────────
//  5.  INSERT / UPDATE WITH RLS
// ──────────────────────────────────────────────

/**
 * ## Insert a document — RLS uses RETURNING check
 *
 * On INSERT, RLS evaluates the policy's `WITH CHECK` clause (or `USING` if
 * no separate `WITH CHECK` exists). The insert succeeds only if the new row
 * satisfies `owner_id = current_setting('app.current_user_id')::uuid`.
 *
 * Drizzle's `returning()` receives the row only after the policy permits it.
 * If the policy rejects the row, the INSERT fails with a permissions error.
 *
 * @throws {PostgresError} if RLS rejects the insert (e.g., owner_id mismatch)
 */
async function createDocument(ownerId: string, title: string, folderId?: string) {
  // NOTE: owner_id is set by the application layer to match the authenticated
  // user. If a bug ever sets it to a different user's ID, RLS blocks it.
  const [doc] = await db
    .insert(documents)
    .values({
      ownerId,
      title,
      folderId: folderId ?? null,
    })
    .returning();

  return doc;
}

/**
 * ## Update a document — RLS filters the target row
 *
 * On UPDATE, RLS first filters the row using `USING` (which rows are visible)
 * and then checks `WITH CHECK` (whether the updated row is permissible).
 *
 * If user A tries to UPDATE a document owned by user B, RLS returns 0
 * affected rows — Drizzle reports `rowCount = 0` but does NOT throw.
 *
 * @returns The number of affected rows (0 if RLS blocked it)
 */
async function updateDocumentTitle(documentId: string, newTitle: string) {
  const updated = await db
    .update(documents)
    .set({ title: newTitle })
    .where(eq(documents.id, documentId))
    .returning({ id: documents.id });

  // updated.length is 0 if RLS filtered the row out (wrong tenant)
  return updated.length;
}

/**
 * ## Delete a document — RLS deletes only visible rows
 *
 * Same filter behavior as UPDATE: RLS's `USING` clause restricts which rows
 * are eligible for deletion. Cross-tenant delete attempts silently affect
 * zero rows. This is defense-in-depth — the application should never attempt
 * cross-tenant operations, but if it does, RLS prevents data leaks.
 */
async function deleteDocument(documentId: string) {
  const deleted = await db
    .delete(documents)
    .where(eq(documents.id, documentId))
    .returning({ id: documents.id });

  return deleted.length;
}

/**
 * ## Insert attachment — RLS verifies document ownership
 *
 * Child-table inserts use the subquery policy:
 *
 * ```sql
 * WITH CHECK (document_id IN (
 *   SELECT id FROM documents
 *   WHERE owner_id = current_setting('app.current_user_id')::uuid
 * ));
 * ```
 *
 * An attacker cannot attach a file to a document they don't own — the INSERT
 * fails with a permissions violation.
 */
async function createAttachment(
  documentId: string,
  filename: string,
  mimeType: string,
  size: number,
  storageKey: string
) {
  const [att] = await db
    .insert(attachments)
    .values({
      documentId,
      filename,
      mimeType,
      size,
      storageKey,
    })
    .returning();

  return att;
}

// ──────────────────────────────────────────────
//  6.  JOIN QUERIES WITH RLS
// ──────────────────────────────────────────────

/**
 * ## Document with its tags — Drizzle join + RLS
 *
 * RLS applies to **each** table independently in a JOIN. The query below
 * joins `documents` and `document_tags` — the user must own the document
 * (from `documents` RLS) AND the tag (from `tags` RLS via the junction).
 *
 * Drizzle's `leftJoin` and `innerJoin` work identically with or without RLS.
 */
async function getDocumentWithTags(documentId: string) {
  const rows = await db
    .select()
    .from(documents)
    .leftJoin(documentTags, eq(documents.id, documentTags.documentId))
    .where(eq(documents.id, documentId));

  // RLS enforces that documents.id is owned by the current user.
  return rows;
}

/**
 * ## Full document detail with eager relations
 *
 * Uses Drizzle's relation query API (`findFirst` with `with`). RLS is
 * applied at the row level by PostgreSQL before Drizzle assembles the
 * result. The relations (`attachments`, `versions`, `tags`) each get their
 * own RLS policy checks.
 */
async function getDocumentDetail(documentId: string) {
  return db.query.documents.findFirst({
    where: (docs, { eq }) => eq(docs.id, documentId),
    with: {
      tags: true,
      attachments: {
        orderBy: (att, { desc }) => [desc(att.createdAt)],
      },
      versions: {
        orderBy: (ver, { desc }) => [desc(ver.createdAt)],
        limit: 5,
      },
    },
  });
}

/**
 * ## Search documents with tag filter (JOIN)
 *
 * Full-text search across the user's documents, filtered by tag. RLS ensures
 * the user never sees search results from other tenants, even though the
 * query does not include `owner_id` in the WHERE clause.
 */
async function searchMyDocumentsByTag(searchQuery: string, tagId: string) {
  return db
    .select()
    .from(documents)
    .innerJoin(documentTags, eq(documents.id, documentTags.documentId))
    .where(
      and(
        eq(documentTags.tagId, tagId),
        sql`${documents.searchVector} @@ plainto_tsquery('english', ${searchQuery})`
      )
    )
    .orderBy(desc(documents.createdAt));
}

/**
 * ## Folder contents with recursive children count
 *
 * A more complex query: list all documents in a folder, plus count the
 * documents in subfolders. RLS applies per-row — the subquery counting
 * children also respects the tenant boundary.
 */
async function getFolderWithDocumentCounts(folderId: string) {
  return db
    .select({
      id: folders.id,
      name: folders.name,
      documentCount: sql<number>`(
        SELECT count(*)::int FROM documents
        WHERE documents.folder_id = folders.id
      )`,
      subfolderCount: sql<number>`(
        SELECT count(*)::int FROM folders AS sub
        WHERE sub.parent_id = folders.id
      )`,
    })
    .from(folders)
    .where(eq(folders.id, folderId));
}

/**
 * ## Cross-tenant safety check (admin only)
 *
 * Admin utility to verify tenant isolation: compare row counts with and
 * without RLS. If the numbers differ, tenant isolation is working.
 */
async function adminVerifyIsolation() {
  // Temporarily disable RLS to get the true total.
  await db.execute(sql`SET LOCAL rls.bypass = 'on'`);
  const totalDocs = await db.select({ count: sql<number>`count(*)::int` }).from(documents);
  await db.execute(sql`SET LOCAL rls.bypass = 'off'`);

  // Re-enable RLS and count the current user's docs.
  const myDocs = await db.select({ count: sql<number>`count(*)::int` }).from(documents);

  const total = totalDocs[0]?.count ?? 0;
  const my = myDocs[0]?.count ?? 0;

  return {
    totalDocuments: total,
    myDocuments: my,
    isolationActive: my < total,
  };
}
