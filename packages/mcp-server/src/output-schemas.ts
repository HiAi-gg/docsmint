import { z } from 'zod';
import type {
  DocsCategory,
  DocsCategoryListItem,
  DocsDocument,
  DocsDocumentIndexRefresh,
  DocsDocumentIndexStatus,
  DocsDocumentListItem,
  DocsDocumentListResponse,
  DocsDocumentPipeline,
  DocsFolder,
  DocsGraphRelatedResponse,
  DocsGraphSearchResponse,
  DocsSearchChunk,
  DocsSearchResponse,
  DocsSearchResult,
  DocsTag,
  DocsVersion,
} from '@hiai-docs/sdk';

const tagSchema: z.ZodType<DocsTag> = z.looseObject({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  createdAt: z.string().optional(),
  documentCount: z.number().optional(),
});

const documentSchema: z.ZodType<DocsDocument> = z.looseObject({
  id: z.string(),
  ownerId: z.string(),
  folderId: z.string().nullable(),
  categoryId: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  contentJson: z.unknown().optional(),
  metadata: z.unknown().optional(),
  visibility: z.enum(['private', 'shared', 'public']),
  createdAt: z.string(),
  updatedAt: z.string(),
  tags: z.array(tagSchema).optional(),
  folderName: z.string().nullable().optional(),
});

const documentListItemSchema: z.ZodType<DocsDocumentListItem> = z.looseObject({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  folderId: z.string().nullable(),
  folderName: z.string().nullable(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tags: z.array(tagSchema),
});

const searchChunkSchema: z.ZodType<DocsSearchChunk> = z.looseObject({
  chunkIndex: z.number(),
  chunkText: z.string(),
  charStart: z.number(),
  charEnd: z.number(),
  score: z.number(),
});

const searchResultSchema: z.ZodType<DocsSearchResult> = z.looseObject({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  folder_id: z.string().nullable(),
  folder_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  tags: z.array(tagSchema).optional(),
  chunks: z.array(searchChunkSchema).optional(),
});

const categoryBaseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  order: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  documentCount: z.number().optional(),
  folderCount: z.number().optional(),
});
const categorySchema: z.ZodType<DocsCategory> = categoryBaseSchema.extend({
  apiMode: z.enum(['unavailable', 'global', 'category']),
  apiPermissionRead: z.boolean(),
  apiPermissionEdit: z.boolean(),
  apiPermissionWrite: z.boolean(),
});
const categoryListItemSchema: z.ZodType<DocsCategoryListItem> = z.union([
  categorySchema,
  categoryBaseSchema,
]);

const graphEntitySchema = z.looseObject({
  name: z.string(),
  type: z.string(),
});

const pipelineStatusSchema = z.enum([
  'pending',
  'processing',
  'ready',
  'retrying',
  'failed',
  'ready_with_warnings',
  'skipped',
  'cancelled',
]);

const pipelineSchema: z.ZodType<DocsDocumentPipeline> = z.looseObject({
  documentId: z.string(),
  generationId: z.string(),
  status: pipelineStatusSchema,
  revision: z.string(),
  stages: z.looseObject({
    prepare: pipelineStatusSchema,
    embed: pipelineStatusSchema,
    graph: pipelineStatusSchema,
    summarize: pipelineStatusSchema,
    finalize: pipelineStatusSchema,
  }),
  batches: z.looseObject({
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
  }),
  warnings: z.array(
    z.looseObject({
      stage: z.enum(['graph', 'summarize']),
      code: z.string(),
      retryable: z.boolean(),
    })
  ),
  updatedAt: z.string(),
});

const indexStatusSchema: z.ZodType<DocsDocumentIndexStatus> = z.looseObject({
  documentId: z.string(),
  embeddingStatus: z.enum(['pending', 'processing', 'ready', 'failed', 'stale']),
  activeGenerationId: z.string().nullable(),
  pendingGenerationId: z.string().nullable(),
  embeddingProfile: z.string().nullable(),
  embeddingErrorCode: z.string().nullable(),
  embeddingUpdatedAt: z.string().nullable(),
  searchable: z.boolean(),
  pipeline: pipelineSchema.nullable(),
});

const versionSchema: z.ZodType<DocsVersion> = z.looseObject({
  id: z.string(),
  documentId: z.string(),
  content: z.string(),
  contentJson: z.unknown().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  label: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  isSnapshot: z.boolean().optional(),
  restoredFrom: z.string().nullable().optional(),
});

const folderSchema: z.ZodType<DocsFolder> = z.looseObject({
  id: z.string(),
  ownerId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  categoryId: z.string().nullable().optional(),
  order: z.number().optional(),
  documentCount: z.number().optional(),
  subfolderCount: z.number().optional(),
  children: z.array(z.lazy(() => folderSchema)).optional(),
  documents: z.array(documentListItemSchema).optional(),
});

const exportedDocumentSchema = z.looseObject({
  markdown: z.string(),
  filename: z.string().optional(),
});

const relatedDocumentsSchema: z.ZodType<DocsGraphRelatedResponse> = z.looseObject({
  related: z.array(
    z.looseObject({
      docId: z.string(),
      relationType: z.string(),
      hopDistance: z.number(),
    })
  ),
});

const graphSearchSchema: z.ZodType<DocsGraphSearchResponse> = z.looseObject({
  query: z.string().optional(),
  entities: z.array(graphEntitySchema),
  relatedDocs: z.array(
    z.looseObject({
      docId: z.string(),
      relationType: z.string(),
      hopDistance: z.number(),
      title: z.string(),
      snippet: z.string(),
    })
  ),
});

const deleteAcknowledgmentSchema = z.looseObject({
  id: z.string().uuid(),
  deleted: z.literal(true),
});

const operationOutputSchemas = {
  search_documents: z.looseObject({
    items: z.array(searchResultSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    diagnostics: z
      .looseObject({
        graphAttempted: z.boolean(),
        graphFailed: z.boolean(),
        graphContribution: z.boolean(),
      })
      .optional(),
  }) satisfies z.ZodType<DocsSearchResponse>,
  get_document: documentSchema,
  create_document: documentSchema,
  update_document: documentSchema,
  list_documents: z.looseObject({
    items: z.array(documentListItemSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  }) satisfies z.ZodType<DocsDocumentListResponse>,
  list_folders: z.array(folderSchema),
  create_folder: folderSchema,
  create_snapshot: versionSchema,
  get_version_history: z.array(versionSchema),
  export_document: exportedDocumentSchema,
  list_categories: z.array(categoryListItemSchema),
  create_category: categorySchema,
  list_tags: z.array(tagSchema),
  get_related_documents: relatedDocumentsSchema,
  search_knowledge_graph: graphSearchSchema,
  get_document_index_status: indexStatusSchema,
  refresh_document_index: z.looseObject({
    documentId: z.string(),
    generationId: z.string(),
    deduplicated: z.boolean(),
  }) satisfies z.ZodType<DocsDocumentIndexRefresh>,
  delete_document: deleteAcknowledgmentSchema,
  delete_folder: deleteAcknowledgmentSchema,
  delete_category: deleteAcknowledgmentSchema,
  restore_document_version: documentSchema,
  create_tag: tagSchema,
  update_tag: tagSchema,
  delete_tag: deleteAcknowledgmentSchema,
  add_tag_to_document: z.looseObject({ documentId: z.string().uuid(), tagId: z.string().uuid(), assigned: z.literal(true) }),
  remove_tag_from_document: z.looseObject({ documentId: z.string().uuid(), tagId: z.string().uuid(), removed: z.literal(true) }),
  update_folder: folderSchema,
  update_category: categorySchema,
  list_trash: z.looseObject({ documents: z.array(z.looseObject({ id: z.string().uuid(), title: z.string(), deletedAt: z.string(), purgeAfter: z.string().nullable() })), folders: z.array(z.unknown()) }),
  restore_trashed_document: z.looseObject({ success: z.literal(true) }),
  permanently_delete_document: deleteAcknowledgmentSchema,
} as const;

const variant = <Name extends string, Schema extends z.ZodType>(operation: Name, result: Schema) =>
  z.object({ operation: z.literal(operation), result });

const toolOutputSchemas = {
  delete_document: operationOutputSchemas.delete_document,
  delete_folder: operationOutputSchemas.delete_folder,
  delete_category: operationOutputSchemas.delete_category,
  delete_tag: operationOutputSchemas.delete_tag,
  create_snapshot: operationOutputSchemas.create_snapshot,
  restore_document_version: operationOutputSchemas.restore_document_version,
  get_document_index_status: operationOutputSchemas.get_document_index_status,
  refresh_document_index: operationOutputSchemas.refresh_document_index,
  list_trash: operationOutputSchemas.list_trash,
  restore_trashed_document: operationOutputSchemas.restore_trashed_document,
  permanently_delete_document: operationOutputSchemas.permanently_delete_document,
  find_documents: z.union([
    variant('list', operationOutputSchemas.list_documents),
    variant('search', operationOutputSchemas.search_documents),
  ]),
  read_document: z.union([
    variant('detail', operationOutputSchemas.get_document),
    variant('markdown', operationOutputSchemas.export_document),
    variant('versions', operationOutputSchemas.get_version_history),
  ]),
  save_document: z.union([
    variant('create', operationOutputSchemas.create_document),
    variant('update', operationOutputSchemas.update_document),
  ]),
  list_workspace_structure: z.union([
    variant('folders', operationOutputSchemas.list_folders),
    variant('categories', operationOutputSchemas.list_categories),
    variant('tags', operationOutputSchemas.list_tags),
  ]),
  save_folder: z.union([
    variant('create', operationOutputSchemas.create_folder),
    variant('update', operationOutputSchemas.update_folder),
  ]),
  save_category: z.union([
    variant('create', operationOutputSchemas.create_category),
    variant('update', operationOutputSchemas.update_category),
  ]),
  save_tag: z.union([
    variant('create', operationOutputSchemas.create_tag),
    variant('update', operationOutputSchemas.update_tag),
  ]),
  set_document_tag: z.union([
    variant('add', operationOutputSchemas.add_tag_to_document),
    variant('remove', operationOutputSchemas.remove_tag_from_document),
  ]),
  explore_graph: z.union([
    variant('neighbors', operationOutputSchemas.get_related_documents),
    variant('search', operationOutputSchemas.search_knowledge_graph),
  ]),
  batch_documents: z.looseObject({
    action: z.enum(['move', 'set_category', 'add_tag', 'remove_tag', 'trash', 'restore', 'refresh_index']),
    total: z.number().int().min(1).max(25),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    aborted: z.boolean(),
    results: z.array(z.union([
      z.looseObject({ id: z.string().uuid(), status: z.literal('ok') }),
      z.looseObject({ id: z.string().uuid(), status: z.literal('error'), error: z.looseObject({ status: z.number().int(), code: z.string(), message: z.string() }) }),
      z.looseObject({ id: z.string().uuid(), status: z.literal('skipped') }),
    ])),
  }),
  get_workspace_item: z.union([
    variant('folder', folderSchema),
    variant('category', categoryListItemSchema),
    variant('tag', tagSchema),
  ]),
} as const;

export { toolOutputSchemas };
