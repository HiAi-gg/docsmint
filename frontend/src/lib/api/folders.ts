import type { Folder, Document, CreateFolderData, UpdateFolderData } from "$lib/types.js";

// ---------------------------------------------------------------------------
// Mock data for development — replace with apiFetch calls when backend is ready
// ---------------------------------------------------------------------------

const MOCK_FOLDERS: Record<string, Folder> = {
  root: {
    id: "root",
    name: "My Workspace",
    parentId: null,
    documentCount: 4,
    createdAt: "2026-01-15T10:00:00Z",
    updatedAt: "2026-05-24T08:30:00Z",
    children: [
      {
        id: "f1",
        name: "Engineering",
        parentId: "root",
        documentCount: 3,
        createdAt: "2026-02-10T14:00:00Z",
        updatedAt: "2026-05-23T16:45:00Z",
        children: [
          {
            id: "f1-1",
            name: "Architecture",
            parentId: "f1",
            documentCount: 2,
            createdAt: "2026-03-01T09:00:00Z",
            updatedAt: "2026-05-22T11:20:00Z",
            children: [],
            documents: [],
          },
          {
            id: "f1-2",
            name: "Runbooks",
            parentId: "f1",
            documentCount: 1,
            createdAt: "2026-03-15T12:00:00Z",
            updatedAt: "2026-05-20T14:10:00Z",
            children: [],
            documents: [],
          },
        ],
        documents: [],
      },
      {
        id: "f2",
        name: "Product",
        parentId: "root",
        documentCount: 2,
        createdAt: "2026-02-20T11:00:00Z",
        updatedAt: "2026-05-24T07:15:00Z",
        children: [
          {
            id: "f2-1",
            name: "Roadmap",
            parentId: "f2",
            documentCount: 1,
            createdAt: "2026-04-01T08:00:00Z",
            updatedAt: "2026-05-19T10:30:00Z",
            children: [],
            documents: [],
          },
        ],
        documents: [],
      },
      {
        id: "f3",
        name: "Design",
        parentId: "root",
        documentCount: 1,
        createdAt: "2026-03-05T15:00:00Z",
        updatedAt: "2026-05-18T09:00:00Z",
        children: [],
        documents: [],
      },
    ],
    documents: [
      {
        id: "d1",
        title: "Getting Started Guide",
        content:
          "Welcome to hiai-docs. This guide will help you set up your workspace and create your first documents. Start by organizing your content into folders.",
        folderId: "root",
        folderName: "My Workspace",
        tags: ["guide", "onboarding"],
        excerpt:
          "Welcome to hiai-docs. This guide will help you set up your workspace and create your first documents.",
        createdAt: "2026-01-15T10:00:00Z",
        updatedAt: "2026-05-24T08:30:00Z",
      },
      {
        id: "d2",
        title: "Project Overview",
        content:
          "hiai-docs is a self-hosted knowledge base with built-in vector embeddings for RAG-ready semantic search. It supports Markdown-first editing with WYSIWYG capabilities.",
        folderId: "root",
        folderName: "My Workspace",
        tags: ["overview"],
        excerpt:
          "hiai-docs is a self-hosted knowledge base with built-in vector embeddings for RAG-ready semantic search.",
        createdAt: "2026-02-01T09:00:00Z",
        updatedAt: "2026-05-22T14:00:00Z",
      },
      {
        id: "d3",
        title: "API Reference",
        content:
          "The API follows REST conventions with JSON payloads. All endpoints require authentication via session cookies or API keys. Rate limiting is applied per-user.",
        folderId: "root",
        folderName: "My Workspace",
        tags: ["api", "reference"],
        excerpt: "The API follows REST conventions with JSON payloads. All endpoints require authentication.",
        createdAt: "2026-02-15T11:00:00Z",
        updatedAt: "2026-05-21T16:30:00Z",
      },
      {
        id: "d4",
        title: "Deployment Notes",
        content:
          "Deploy with Docker Compose. Services include PostgreSQL 18 with pgvector, Redis 8, Ollama for embeddings, MinIO for file storage, and Caddy as reverse proxy.",
        folderId: "root",
        folderName: "My Workspace",
        tags: ["deploy", "infra"],
        excerpt: "Deploy with Docker Compose. Services include PostgreSQL 18 with pgvector, Redis 8, Ollama.",
        createdAt: "2026-03-01T10:00:00Z",
        updatedAt: "2026-05-20T09:15:00Z",
      },
    ],
  },
  f1: {
    id: "f1",
    name: "Engineering",
    parentId: "root",
    documentCount: 3,
    createdAt: "2026-02-10T14:00:00Z",
    updatedAt: "2026-05-23T16:45:00Z",
    children: [
      {
        id: "f1-1",
        name: "Architecture",
        parentId: "f1",
        documentCount: 2,
        createdAt: "2026-03-01T09:00:00Z",
        updatedAt: "2026-05-22T11:20:00Z",
        children: [],
        documents: [],
      },
      {
        id: "f1-2",
        name: "Runbooks",
        parentId: "f1",
        documentCount: 1,
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-05-20T14:10:00Z",
        children: [],
        documents: [],
      },
    ],
    documents: [
      {
        id: "d5",
        title: "Backend Architecture",
        content:
          "The backend uses Elysia on Bun with Drizzle ORM. Routes are organized by domain with Zod validation on all inputs. PostgreSQL 18 with pgvector handles embeddings.",
        folderId: "f1",
        folderName: "Engineering",
        tags: ["architecture", "backend"],
        excerpt: "The backend uses Elysia on Bun with Drizzle ORM. Routes are organized by domain.",
        createdAt: "2026-02-10T14:00:00Z",
        updatedAt: "2026-05-23T16:45:00Z",
      },
      {
        id: "d6",
        title: "Frontend Stack",
        content:
          "SvelteKit 2 with Svelte 5 runes for reactive UIs. shadcn-svelte provides component primitives. Tailwind CSS v4 handles styling with CSS variables for theming.",
        folderId: "f1",
        folderName: "Engineering",
        tags: ["frontend", "svelte"],
        excerpt: "SvelteKit 2 with Svelte 5 runes for reactive UIs. shadcn-svelte provides component primitives.",
        createdAt: "2026-02-15T09:00:00Z",
        updatedAt: "2026-05-22T10:30:00Z",
      },
      {
        id: "d7",
        title: "Database Schema",
        content:
          "Tables: users, documents, folders, tags, document_tags, share_links, embeddings. All tables have owner_id for data isolation. pgvector column type for embeddings.",
        folderId: "f1",
        folderName: "Engineering",
        tags: ["database", "schema"],
        excerpt: "Tables: users, documents, folders, tags, document_tags, share_links, embeddings.",
        createdAt: "2026-03-01T11:00:00Z",
        updatedAt: "2026-05-21T15:00:00Z",
      },
    ],
  },
  "f1-1": {
    id: "f1-1",
    name: "Architecture",
    parentId: "f1",
    documentCount: 2,
    createdAt: "2026-03-01T09:00:00Z",
    updatedAt: "2026-05-22T11:20:00Z",
    children: [],
    documents: [
      {
        id: "d8",
        title: "Module Boundaries",
        content:
          "api/ handles HTTP layer, embedding/ manages the vector pipeline, lib/ contains shared utilities. No cross-imports between api and embedding modules.",
        folderId: "f1-1",
        folderName: "Architecture",
        tags: ["architecture"],
        excerpt: "api/ handles HTTP layer, embedding/ manages the vector pipeline, lib/ contains shared utilities.",
        createdAt: "2026-03-01T09:00:00Z",
        updatedAt: "2026-05-22T11:20:00Z",
      },
      {
        id: "d9",
        title: "Embedding Pipeline Design",
        content:
          "Documents are chunked into 500-token segments with 50-token overlap. Each chunk gets embedded via the configured provider (Ollama, OpenRouter, or Voyage).",
        folderId: "f1-1",
        folderName: "Architecture",
        tags: ["embeddings", "pipeline"],
        excerpt: "Documents are chunked into 500-token segments with 50-token overlap for embedding.",
        createdAt: "2026-03-10T10:00:00Z",
        updatedAt: "2026-05-20T14:00:00Z",
      },
    ],
  },
  "f1-2": {
    id: "f1-2",
    name: "Runbooks",
    parentId: "f1",
    documentCount: 1,
    createdAt: "2026-03-15T12:00:00Z",
    updatedAt: "2026-05-20T14:10:00Z",
    children: [],
    documents: [
      {
        id: "d10",
        title: "Incident Response",
        content:
          "1. Check service health endpoints. 2. Review Dozzle logs. 3. Check Beszel for resource issues. 4. Restart affected containers. 5. Update Uptime Kuma status.",
        folderId: "f1-2",
        folderName: "Runbooks",
        tags: ["ops", "incident"],
        excerpt: "Check service health endpoints. Review Dozzle logs. Check Beszel for resource issues.",
        createdAt: "2026-03-15T12:00:00Z",
        updatedAt: "2026-05-20T14:10:00Z",
      },
    ],
  },
  f2: {
    id: "f2",
    name: "Product",
    parentId: "root",
    documentCount: 2,
    createdAt: "2026-02-20T11:00:00Z",
    updatedAt: "2026-05-24T07:15:00Z",
    children: [
      {
        id: "f2-1",
        name: "Roadmap",
        parentId: "f2",
        documentCount: 1,
        createdAt: "2026-04-01T08:00:00Z",
        updatedAt: "2026-05-19T10:30:00Z",
        children: [],
        documents: [],
      },
    ],
    documents: [
      {
        id: "d11",
        title: "Product Vision",
        content:
          "hiai-docs aims to be the go-to self-hosted knowledge base for teams that want AI-powered search without vendor lock-in. Open source, privacy-first, RAG-ready.",
        folderId: "f2",
        folderName: "Product",
        tags: ["vision", "strategy"],
        excerpt:
          "hiai-docs aims to be the go-to self-hosted knowledge base for teams that want AI-powered search.",
        createdAt: "2026-02-20T11:00:00Z",
        updatedAt: "2026-05-24T07:15:00Z",
      },
      {
        id: "d12",
        title: "User Personas",
        content:
          "Primary: Engineering teams needing internal docs. Secondary: Small companies replacing Notion. Tertiary: AI developers building RAG pipelines.",
        folderId: "f2",
        folderName: "Product",
        tags: ["personas", "research"],
        excerpt: "Primary: Engineering teams needing internal docs. Secondary: Small companies replacing Notion.",
        createdAt: "2026-03-01T09:00:00Z",
        updatedAt: "2026-05-23T08:00:00Z",
      },
    ],
  },
  "f2-1": {
    id: "f2-1",
    name: "Roadmap",
    parentId: "f2",
    documentCount: 1,
    createdAt: "2026-04-01T08:00:00Z",
    updatedAt: "2026-05-19T10:30:00Z",
    children: [],
    documents: [
      {
        id: "d13",
        title: "Q2 2026 Roadmap",
        content:
          "Phase 1: Core CRUD + folders. Phase 2: Embeddings + search. Phase 3: Sharing + collaboration. Phase 4: API + integrations.",
        folderId: "f2-1",
        folderName: "Roadmap",
        tags: ["roadmap", "q2"],
        excerpt: "Phase 1: Core CRUD + folders. Phase 2: Embeddings + search. Phase 3: Sharing + collaboration.",
        createdAt: "2026-04-01T08:00:00Z",
        updatedAt: "2026-05-19T10:30:00Z",
      },
    ],
  },
  f3: {
    id: "f3",
    name: "Design",
    parentId: "root",
    documentCount: 1,
    createdAt: "2026-03-05T15:00:00Z",
    updatedAt: "2026-05-18T09:00:00Z",
    children: [],
    documents: [
      {
        id: "d14",
        title: "Design System",
        content:
          "Uses shadcn-svelte new-york style with slate base color. CSS variables for light/dark theming. Tailwind CSS v4 with @theme directive for token registration.",
        folderId: "f3",
        folderName: "Design",
        tags: ["design", "ui"],
        excerpt: "Uses shadcn-svelte new-york style with slate base color. CSS variables for light/dark theming.",
        createdAt: "2026-03-05T15:00:00Z",
        updatedAt: "2026-05-18T09:00:00Z",
      },
    ],
  },
};

/** Simulated API delay */
function delay(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Get a single folder by ID with its children and documents. */
export async function getFolder(id: string): Promise<Folder> {
  await delay();
  const folder = MOCK_FOLDERS[id];
  if (!folder) {
    throw new Error(`Folder not found: ${id}`);
  }
  return structuredClone(folder);
}

/** List all folders under a given parent. Returns flat immediate children. */
export async function listFolders(parentId: string | null = null): Promise<Folder[]> {
  await delay(200);
  if (parentId === null) {
    return [structuredClone(MOCK_FOLDERS["root"])];
  }
  const parent = MOCK_FOLDERS[parentId];
  if (!parent) {
    return [];
  }
  return structuredClone(parent.children);
}

/** Get breadcrumb path from root to the specified folder. */
export async function getFolderPath(
  folderId: string,
): Promise<Array<{ id: string; name: string }>> {
  await delay(150);
  const path: Array<{ id: string; name: string }> = [];
  let currentId: string | null = folderId;

  while (currentId) {
    const folder: Folder | undefined = MOCK_FOLDERS[currentId];
    if (!folder) break;
    path.unshift({ id: folder.id, name: folder.name });
    currentId = folder.parentId;
  }

  return path;
}

/** Create a new folder (mock). */
export async function createFolder(data: CreateFolderData): Promise<Folder> {
  await delay(400);
  const newFolder: Folder = {
    id: `f-${Date.now()}`,
    name: data.name,
    parentId: data.parentId ?? null,
    documentCount: 0,
    children: [],
    documents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return newFolder;
}

/** Update a folder (mock). */
export async function updateFolder(id: string, data: UpdateFolderData): Promise<Folder> {
  await delay(300);
  const folder = MOCK_FOLDERS[id];
  if (!folder) {
    throw new Error(`Folder not found: ${id}`);
  }
  return {
    ...structuredClone(folder),
    ...data,
    updatedAt: new Date().toISOString(),
  };
}

/** Delete a folder (mock). */
export async function deleteFolder(id: string): Promise<void> {
  await delay(300);
  if (!MOCK_FOLDERS[id]) {
    throw new Error(`Folder not found: ${id}`);
  }
}

/** Duplicate a document (mock). */
export async function duplicateDocument(docId: string): Promise<Document> {
  await delay(400);
  for (const folder of Object.values(MOCK_FOLDERS)) {
    const doc = folder.documents.find((d) => d.id === docId);
    if (doc) {
      return {
        ...structuredClone(doc),
        id: `d-${Date.now()}`,
        title: `${doc.title} (Copy)`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }
  throw new Error(`Document not found: ${docId}`);
}

/** Delete a document (mock). */
export async function deleteDocument(docId: string): Promise<void> {
  await delay(300);
  for (const folder of Object.values(MOCK_FOLDERS)) {
    if (folder.documents.some((d) => d.id === docId)) return;
  }
  throw new Error(`Document not found: ${docId}`);
}
