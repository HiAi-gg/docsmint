import { apiFetch } from "./client.js";

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
  documentCount?: number;
}

export async function listTags(): Promise<Tag[]> {
  return apiFetch("/api/tags");
}
