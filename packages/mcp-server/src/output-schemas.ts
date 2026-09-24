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

import { capabilityCatalog } from './capabilities.js';

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

const toolOutputSchemas = {
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
} satisfies Record<(typeof capabilityCatalog.tools)[number], z.ZodType>;

export { toolOutputSchemas };
