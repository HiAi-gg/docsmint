/**
 * REST client for hiai-docs.
 *
 * Reads configuration from environment:
 *   HIAI_DOCS_URL       — base URL (default: http://localhost:50700)
 *   HIAI_DOCS_API_KEY   — bearer token for the API
 *
 * Bun-native. Uses global `fetch`. Throws on non-2xx responses with the
 * error message extracted from the response body when possible.
 */

import type { ExportResponse } from "./types.js";

const DEFAULT_BASE_URL = "http://localhost:50700";

function readConfig() {
  const baseUrl = (process.env.HIAI_DOCS_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.HIAI_DOCS_API_KEY ?? "";
  return { baseUrl, apiKey };
}

export class HiaiDocsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "HiaiDocsError";
  }
}

type QueryValue = string | number | boolean | string[] | undefined;

async function request<T>(
  method: string,
  path: string,
  options: { query?: Record<string, QueryValue>; body?: unknown } = {},
): Promise<T> {
  const { baseUrl, apiKey } = readConfig();

  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${baseUrl}/`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.length > 0) url.searchParams.set(key, value.join(","));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, { method, headers, body });

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const payload: unknown = isJson
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);

  if (!response.ok) {
    const message =
      (isJson && payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : typeof payload === "string" && payload.length > 0
          ? payload
          : `HTTP ${response.status} ${response.statusText}`) ||
      `HTTP ${response.status}`;
    throw new HiaiDocsError(message, response.status, payload);
  }

  return payload as T;
}

function joinId(...segments: string[]): string {
  return segments
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export const client = {
  search(params: {
    query: string;
    folder?: string;
    tags?: string[];
    limit?: number;
  }) {
    return request("GET", "/api/search", {
      query: {
        q: params.query,
        folder: params.folder,
        tags: params.tags,
        limit: params.limit,
      },
    });
  },

  getDocument(id: string) {
    return request("GET", `/api/${joinId("documents", id)}`);
  },

  createDocument(input: { title: string; content?: string; folderId?: string }) {
    return request("POST", "/api/documents", { body: input });
  },

  updateDocument(id: string, input: { title?: string; content?: string }) {
    return request("PATCH", `/api/${joinId("documents", id)}`, { body: input });
  },

  listDocuments(params: {
    folderId?: string;
    tag?: string;
    page?: number;
    limit?: number;
  }) {
    return request("GET", "/api/documents", { query: params });
  },

  listFolders(params: { parentId?: string }) {
    return request("GET", "/api/folders", { query: { parentId: params.parentId } });
  },

  createFolder(input: { name: string; parentId?: string }) {
    return request("POST", "/api/folders", { body: input });
  },

  createSnapshot(
    documentId: string,
    input: { label: string; description?: string },
  ) {
    return request(
      "POST",
      `/api/${joinId("documents", documentId, "versions")}`,
      { body: input },
    );
  },

  getVersionHistory(documentId: string, onlySnapshots?: boolean) {
    return request(
      "GET",
      `/api/${joinId("documents", documentId, "versions")}`,
      { query: { onlySnapshots } },
    );
  },

  async exportDocument(id: string): Promise<ExportResponse> {
    const markdown = await request<string>(
      "GET",
      `/api/${joinId("documents", id, "export")}`,
    );
    return { markdown };
  },
};

export type HiaiDocsClient = typeof client;
