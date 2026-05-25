/** Shared types for hiai-docs frontend */

export interface Document {
  id: string;
  title: string;
  content?: string;
  folderId: string | null;
  folderName: string;
  tags: string[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  excerpt: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  documentCount: number;
  children: Folder[];
  documents: Document[];
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export type ViewMode = "grid" | "list";
export type SortOption = "name" | "updated" | "created";
export type SortDirection = "asc" | "desc";

export interface CreateFolderData {
  name: string;
  parentId?: string | null;
}

export interface UpdateFolderData {
  name?: string;
  parentId?: string | null;
}
