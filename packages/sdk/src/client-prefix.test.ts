import { expect, test } from "bun:test";
import { DocsClient, normalizeDocsSearchResult } from "./client";

test("API prefix selects one endpoint without probing or write fallback", async () => {
  const seen: string[] = [];
  const client = new DocsClient({ baseUrl: "https://docs.invalid/", apiPrefix: "/api/v1", retries: 1,
    fetch: (async (url) => { seen.push(String(url)); return Response.json({items: [], total:0,page:1,limit:20}); }) as unknown as typeof fetch });
  await client.listDocs({ categoryId: "category", rootOnly: true, tagIds: ["a", "b"], tagMatch: "any", q: "literal%", updatedFrom: "2026-01-01T00:00:00Z", sortBy: "title", sortOrder: "asc" });
  expect(seen).toHaveLength(1);
  const url = new URL(seen[0]!);
  expect(url.pathname).toBe("/api/v1/documents");
  expect(url.searchParams.get("tagIds")).toBe("a,b");
  expect(url.searchParams.get("categoryId")).toBe("category");
  expect(url.searchParams.get("rootOnly")).toBe("true");
  expect(url.searchParams.get("q")).toBe("literal%");
  expect(url.searchParams.get("sortBy")).toBe("title");
});

test("old clients retain the api prefix", async () => {
  let path = "";
  const client = new DocsClient({baseUrl:"https://docs.invalid", retries:1, fetch:(async(url) => { path=new URL(String(url)).pathname; return Response.json({items:[]}); }) as unknown as typeof fetch});
  await client.listDocs();
  expect(path).toBe("/api/documents");
});

test("normalizes old search data without discarding aliases", () => {
  const old = { id:"doc", title:"Title", snippet:"Text", score:1, folder_id:"folder", folder_name:"Folder", created_at:"2026-01-01T00:00:00Z", updated_at:"2026-01-02T00:00:00Z" };
  expect(normalizeDocsSearchResult(old)).toMatchObject({ ...old, folderId:"folder", folderName:"Folder", createdAt:old.created_at, updatedAt:old.updated_at });
  expect(normalizeDocsSearchResult({...old, folderId:null}).folderId).toBeNull();
});

test("rejects an unsupported API prefix without making a request", () => {
  expect(() => new DocsClient({baseUrl:"https://docs.invalid",apiPrefix:"/admin" as never})).toThrow("apiPrefix");
});
