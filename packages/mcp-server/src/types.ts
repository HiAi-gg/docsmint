import type {
  DocsCategory,
  DocsDocument,
  DocsDocumentListResponse,
  DocsFolder,
  DocsSearchResponse,
  DocsTag,
  DocsVersion,
} from '@hiai-docs/sdk';

export type Tag = DocsTag;
export type DocumentDetail = DocsDocument;
export type SearchResponse = DocsSearchResponse;
export type ListDocumentsResponse = DocsDocumentListResponse;
export type Folder = DocsFolder;
export type Version = DocsVersion;
export type Category = DocsCategory;

/** Stable MCP wrapper around the SDK's raw-Markdown export response. */
export interface ExportResponse {
  id?: string;
  title?: string;
  updatedAt?: string;
  workspaceId?: string | null;
  workspaceSlug?: string | null;
  url?: string | null;
  markdown: string;
  filename?: string;
}
