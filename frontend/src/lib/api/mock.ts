/**
 * Mock data for development. Will be replaced by real API calls in Phase 6.
 */
import type { Document, Folder, Tag } from "$lib/types";

/** Simulates API latency */
function delay(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TAGS: Tag[] = [
  { id: "t1", name: "architecture", color: "#6366f1" },
  { id: "t2", name: "guide", color: "#10b981" },
  { id: "t3", name: "api", color: "#f59e0b" },
  { id: "t4", name: "draft", color: "#ef4444" },
  { id: "t5", name: "reference", color: "#8b5cf6" },
  { id: "t6", name: "tutorial", color: "#ec4899" },
];

const FOLDERS: Folder[] = [
  {
    id: "f1",
    name: "Getting Started",
    parentId: null,
    documentCount: 4,
    children: [
      {
        id: "f1-1",
        name: "Installation",
        parentId: "f1",
        documentCount: 2,
        children: [],
        documents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "f1-2",
        name: "Configuration",
        parentId: "f1",
        documentCount: 1,
        children: [],
        documents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    documents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "f2",
    name: "Architecture",
    parentId: null,
    documentCount: 6,
    children: [
      {
        id: "f2-1",
        name: "Backend",
        parentId: "f2",
        documentCount: 3,
        children: [
          {
            id: "f2-1-1",
            name: "API Design",
            parentId: "f2-1",
            documentCount: 2,
            children: [],
            documents: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        documents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "f2-2",
        name: "Frontend",
        parentId: "f2",
        documentCount: 3,
        children: [],
        documents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    documents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "f3",
    name: "Guides",
    parentId: null,
    documentCount: 5,
    children: [],
    documents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "f4",
    name: "API Reference",
    parentId: null,
    documentCount: 8,
    children: [],
    documents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const DOCUMENTS: Document[] = [
  {
    id: "d1",
    title: "Introduction to hiai-docs",
    folderId: "f1",
    folderName: "Getting Started",
    tags: ["guide"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    excerpt: "Learn the basics of hiai-docs, a self-hosted knowledge base with AI-native search.",
  },
  {
    id: "d2",
    title: "Docker Deployment Guide",
    folderId: "f1-1",
    folderName: "Installation",
    tags: ["guide", "architecture"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 20).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    excerpt: "Step-by-step guide to deploying hiai-docs with Docker and Docker Compose.",
  },
  {
    id: "d3",
    title: "API Authentication",
    folderId: "f2-1-1",
    folderName: "API Design",
    tags: ["api", "reference"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 15).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    excerpt: "How to authenticate with the hiai-docs REST API using Better Auth sessions.",
  },
  {
    id: "d4",
    title: "Embedding Pipeline",
    folderId: "f2",
    folderName: "Architecture",
    tags: ["architecture", "reference"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    excerpt: "Deep dive into the vector embedding pipeline: chunking, embedding providers, and fallbacks.",
  },
  {
    id: "d5",
    title: "Search Configuration",
    folderId: "f1-2",
    folderName: "Configuration",
    tags: ["guide"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    excerpt: "Configure hybrid search weights, embedding providers, and indexing behavior.",
  },
  {
    id: "d6",
    title: "Svelte 5 Component Patterns",
    folderId: "f2-2",
    folderName: "Frontend",
    tags: ["tutorial"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
    excerpt: "Best practices for building Svelte 5 components with runes and shadcn-svelte.",
  },
  {
    id: "d7",
    title: "Database Schema Reference",
    folderId: "f4",
    folderName: "API Reference",
    tags: ["reference", "api"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 96).toISOString(),
    excerpt: "Complete reference of all Drizzle ORM tables, columns, and relations.",
  },
  {
    id: "d8",
    title: "Environment Variables",
    folderId: "f1",
    folderName: "Getting Started",
    tags: ["reference"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 120).toISOString(),
    excerpt: "Full list of environment variables, defaults, and required vs optional settings.",
  },
  {
    id: "d9",
    title: "Contributing Guide",
    folderId: "f3",
    folderName: "Guides",
    tags: ["guide"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 168).toISOString(),
    excerpt: "How to contribute to hiai-docs: fork, branch, test, and submit a pull request.",
  },
  {
    id: "d10",
    title: "REST API Endpoints",
    folderId: "f4",
    folderName: "API Reference",
    tags: ["api", "reference"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 200).toISOString(),
    excerpt: "Complete list of REST API endpoints with request/response examples.",
  },
];

// --- Mock API functions ---

export async function fetchDocuments(): Promise<Document[]> {
  await delay();
  return [...DOCUMENTS];
}

export async function fetchRecentDocuments(limit = 5): Promise<Document[]> {
  await delay(200);
  return [...DOCUMENTS]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}

export async function fetchFolders(): Promise<Folder[]> {
  await delay();
  return [...FOLDERS];
}

export async function fetchTags(): Promise<Tag[]> {
  await delay(200);
  return [...TAGS];
}

/** Format a date as a relative time string */
export function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / (1000 * 60));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
