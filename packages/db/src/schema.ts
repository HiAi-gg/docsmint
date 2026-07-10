import { pgTable, uuid, text, timestamp, bigint, jsonb, index, uniqueIndex, customType, boolean, integer, pgEnum, type AnyPgColumn } from "drizzle-orm/pg-core";

// pgvector vector type — maps to PostgreSQL vector(n) column
const vector = customType<{ data: number[] }>({
  dataType() {
    return "vector(1024)";
  },
  toDriver(value: number[]) {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown) {
    if (typeof value === "string") return JSON.parse(value) as number[];
    return value as number[];
  },
});

// PostgreSQL tsvector type — used for documents.search_vector full-text search
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

import { relations, sql } from "drizzle-orm";

// ============================================
// Enums
// ============================================
export const documentVisibilityEnum = pgEnum("document_visibility", ["private", "shared", "public"]);
export const shareRoleEnum = pgEnum("share_role", ["viewer", "commenter", "editor"]);

// ============================================
// users — managed by Better Auth
// ============================================
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  emailVerified: boolean("email_verified").default(false),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================
// sessions — managed by Better Auth
// ============================================
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("sessions_user_id_idx").on(table.userId),
  index("sessions_revoked_at_idx")
    .on(table.revokedAt)
    .where(sql`${table.revokedAt} IS NOT NULL`),
]);

// ============================================
// accounts — managed by Better Auth
// ============================================
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("accounts_user_id_idx").on(table.userId),
  uniqueIndex("accounts_provider_account_idx").on(table.providerId, table.accountId),
]);

// ============================================
// verifications — managed by Better Auth
// ============================================
export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("verifications_identifier_idx").on(table.identifier),
]);

// ============================================
// folders — hierarchical folder structure
// ============================================
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, {
      onDelete: "set null",
    }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("folders_owner_id_idx").on(table.ownerId),
    index("folders_parent_id_idx").on(table.parentId),
    index("folders_category_id_idx").on(table.categoryId),
  ]
);

// Self-referencing for parent folder
export const folderRelations = relations(folders, ({ one, many }) => ({
  owner: one(users, { fields: [folders.ownerId], references: [users.id] }),
  parent: one(folders, {
    fields: [folders.parentId],
    references: [folders.id],
    relationName: "folderParent",
  }),
  category: one(categories, {
    fields: [folders.categoryId],
    references: [categories.id],
  }),
  children: many(folders, { relationName: "folderParent" }),
  documents: many(documents),
}));

// ============================================
// documents — core content
// ============================================
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default("Untitled"),
    content: text("content").default(""),
    contentJson: jsonb("content_json"),
    metadata: jsonb("metadata"),
    visibility: documentVisibilityEnum("visibility").notNull().default("private"),
    contentHash: text("content_hash"),  // SHA-256 of title+content for smart re-embed
    // Smart-reembed fields (added by migration 0009_lying_hardball.sql).
    // These four columns are required by `backend/src/lib/reembed.ts` and
    // `backend/src/lib/reembed-cron.ts`; the TypeScript schema must stay in
    // sync with the migration or Drizzle queries fail at compile time.
    lastSignificantHash: text("last_significant_hash"),
    lastSignificantUpdateAt: timestamp("last_significant_update_at"),
    pendingMinorChanges: boolean("pending_minor_changes")
      .default(false)
      .notNull(),
    metadataChangedAt: timestamp("metadata_changed_at"),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))`
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("documents_owner_id_idx").on(table.ownerId),
    index("documents_folder_id_idx").on(table.folderId),
    index("documents_category_id_idx").on(table.categoryId),
    index("documents_created_at_idx").on(table.createdAt),
    index("idx_documents_search_vector").using("gin", table.searchVector),
    index("idx_documents_title_trgm").using(
      "gin",
      sql`${table.title} gin_trgm_ops`
    ),
  ]
);

export const documentRelations = relations(documents, ({ one, many }) => ({
  owner: one(users, { fields: [documents.ownerId], references: [users.id] }),
  folder: one(folders, {
    fields: [documents.folderId],
    references: [folders.id],
  }),
  category: one(categories, {
    fields: [documents.categoryId],
    references: [categories.id],
  }),
  tags: many(documentTags),
  attachments: many(attachments),
  versions: many(versions),
}));

// ============================================
// tags — document tags
// ============================================
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("tags_owner_id_idx").on(table.ownerId),
    uniqueIndex("tags_owner_name_idx").on(table.ownerId, table.name),
  ]
);

export const tagRelations = relations(tags, ({ many }) => ({
  documents: many(documentTags),
}));

// ============================================
// categories — document/folder classification
// ============================================
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    order: integer("order").notNull().default(0),
    apiMode: text("api_mode").notNull().default("unavailable"),
    apiPermissionRead: boolean("api_permission_read").notNull().default(false),
    apiPermissionEdit: boolean("api_permission_edit").notNull().default(false),
    apiPermissionWrite: boolean("api_permission_write").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("categories_owner_id_idx").on(table.ownerId),
    index("categories_api_mode_idx").on(table.apiMode),
  ]
);

export const categoryRelations = relations(categories, ({ one, many }) => ({
  owner: one(users, { fields: [categories.ownerId], references: [users.id] }),
  folders: many(folders),
  documents: many(documents),
}));

// ============================================
// document_tags — many-to-many
// ============================================
export const documentTags = pgTable(
  "document_tags",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("document_tags_unique_idx").on(table.documentId, table.tagId),
  ]
);

export const documentTagRelations = relations(documentTags, ({ one }) => ({
  document: one(documents, {
    fields: [documentTags.documentId],
    references: [documents.id],
  }),
  tag: one(tags, { fields: [documentTags.tagId], references: [tags.id] }),
}));

// ============================================
// share_links — sharing tokens
// ============================================
export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    folderId: uuid("folder_id").references(() => folders.id, {
      onDelete: "cascade",
    }),
    token: text("token").notNull().unique(),
    passwordHash: text("password_hash"),
    role: shareRoleEnum("role").notNull().default("viewer"),
    expiresAt: timestamp("expires_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("share_links_token_idx").on(table.token),
    index("share_links_document_id_idx").on(table.documentId),
    index("share_links_folder_id_idx").on(table.folderId),
  ]
);

export const shareLinkRelations = relations(shareLinks, ({ one, many }) => ({
  document: one(documents, {
    fields: [shareLinks.documentId],
    references: [documents.id],
  }),
  folder: one(folders, {
    fields: [shareLinks.folderId],
    references: [folders.id],
  }),
  creator: one(users, {
    fields: [shareLinks.createdBy],
    references: [users.id],
  }),
  guestAccess: many(guestAccess),
}));

// ============================================
// guest_access — guest email grants
// ============================================
export const guestAccess = pgTable(
  "guest_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shareLinkId: uuid("share_link_id")
      .notNull()
      .references(() => shareLinks.id, { onDelete: "cascade" }),
    guestEmail: text("guest_email").notNull(),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
  },
  (table) => [index("guest_access_share_link_idx").on(table.shareLinkId)]
);

export const guestAccessRelations = relations(guestAccess, ({ one }) => ({
  shareLink: one(shareLinks, {
    fields: [guestAccess.shareLinkId],
    references: [shareLinks.id],
  }),
}));

// ============================================
// attachments — file uploads (SeaweedFS)
// ============================================
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("attachments_document_id_idx").on(table.documentId)]
);

export const attachmentRelations = relations(attachments, ({ one }) => ({
  document: one(documents, {
    fields: [attachments.documentId],
    references: [documents.id],
  }),
}));

// ============================================
// versions — document version history
// ============================================
export const versions = pgTable(
  "versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    contentJson: jsonb("content_json"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    label: text("label"),
    description: text("description"),
    isSnapshot: boolean("is_snapshot").default(false),
    restoredFrom: uuid("restored_from"),
  },
  (table) => [
    index("versions_document_id_idx").on(table.documentId),
    index("versions_created_at_idx").on(table.createdAt),
    index("versions_is_snapshot_idx").on(table.isSnapshot),
  ]
);

// ============================================
// document_embeddings — multi-chunk pgvector storage
// ============================================
export const documentEmbeddings = pgTable(
  "document_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: bigint("chunk_index", { mode: "number" }).notNull(),
    chunkText: text("chunk_text").notNull(),
    chunkHash: text("chunk_hash"),
    charStart: integer("char_start").notNull().default(0),
    charEnd: integer("char_end").notNull().default(0),
    embedding: vector("embedding"),
    // Identifier of the embedding model that produced the vector above.
    // Empty string ("") means "unknown / legacy row" (pre-v1 rows that
    // existed before this column was introduced). The targeted reindex
    // endpoint at POST /api/admin/reindex/model filters on this column
    // to refresh only docs whose stored model does not match the
    // currently-configured EMBEDDING_MODEL.
    embeddingModel: text("embedding_model").notNull().default(""),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("document_embeddings_doc_id_idx").on(table.documentId),
    uniqueIndex("document_embeddings_doc_chunk_idx").on(table.documentId, table.chunkIndex),
    // Backs POST /api/admin/reindex/model which selects docs whose stored
    // embedding model differs from the currently-configured EMBEDDING_MODEL.
    index("idx_document_embeddings_embedding_model").on(table.embeddingModel),
    index("idx_document_embeddings_hnsw").using(
      "hnsw",
      sql`${table.embedding} vector_cosine_ops`
    ),
    // StreamingDiskANN index for >100k row corpora. Co-exists with HNSW;
    // the planner picks the right one based on table size and memory.
    // Requires the pgvectorscale extension (enabled in postgres/init.sql).
    index("idx_document_embeddings_diskann").using(
      "diskann",
      sql`${table.embedding} vector_cosine_ops`
    ),
  ]
);

export const documentEmbeddingRelations = relations(documentEmbeddings, ({ one }) => ({
  document: one(documents, {
    fields: [documentEmbeddings.documentId],
    references: [documents.id],
  }),
}));

// ============================================
// api_keys — user API keys
// ============================================
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    scopes: jsonb("scopes").notNull().default("[]"),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_api_keys_owner").on(table.ownerId),
    index("idx_api_keys_prefix").on(table.prefix),
  ]
);

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  owner: one(users, { fields: [apiKeys.ownerId], references: [users.id] }),
}));

// ============================================
// audit_log — append-only audit trail
// ============================================
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    details: jsonb("details").notNull().default("{}"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_audit_log_actor").on(table.actorId),
    index("idx_audit_log_resource").on(table.resourceType, table.resourceId),
    index("idx_audit_log_created").on(table.createdAt),
  ]
);

export const versionRelations = relations(versions, ({ one }) => ({
  document: one(documents, {
    fields: [versions.documentId],
    references: [documents.id],
  }),
  creator: one(users, {
    fields: [versions.createdBy],
    references: [users.id],
  }),
}));
