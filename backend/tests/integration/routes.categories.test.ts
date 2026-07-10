/**
 * HTTP-level tests for category routes.
 * Tests:
 *   GET    /api/categories
 *   POST   /api/categories
 *   PATCH  /api/categories/:id
 *   DELETE /api/categories/:id
 *
 * Verifies CRUD, validation, ownership isolation (one user cannot see or
 * mutate another user's categories), and the 409 duplicate-name behaviour.
 *
 * Categories are a Phase-1 of the 5-features plan. They mirror the tags
 * CRUD shape but with a dedicated table (no many-to-many join with
 * documents — categories are assigned by `documents.category_id` /
 * `folders.category_id` FKs that use `ON DELETE SET NULL`).
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  OTHER_USER_ID,
  OWNER_ID,
  getState,
  noAuthHeaders,
  ownerHeaders,
  request,
  resetState,
  setupHarness,
} from "./_harness";

let app: any;

beforeAll(async () => {
  const built = await setupHarness();
  app = built.app;
});

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

function authedGet(path: string) {
  return request(app, path, { method: "GET", headers: ownerHeaders() });
}
function authedPost(path: string, body: any) {
  return request(app, path, {
    method: "POST",
    headers: ownerHeaders(),
    body: JSON.stringify(body),
  });
}
function authedPatch(path: string, body: any) {
  return request(app, path, {
    method: "PATCH",
    headers: ownerHeaders(),
    body: JSON.stringify(body),
  });
}
function authedDelete(path: string) {
  return request(app, path, { method: "DELETE", headers: ownerHeaders() });
}

function seedCategory(id: string, ownerId: string, name: string): void {
  getState().categories.set(id, {
    id,
    ownerId,
    name,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("GET /api/categories", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app, "/api/categories", {
      method: "GET",
      headers: noAuthHeaders(),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 200 with empty array when no categories exist", async () => {
    const res = await authedGet("/api/categories");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns categories owned by the current user", async () => {
    seedCategory("cat-1", OWNER_ID, "alpha");
    seedCategory("cat-2", OWNER_ID, "beta");
    seedCategory("cat-other", OTHER_USER_ID, "should-not-appear");
    const res = await authedGet("/api/categories");
    expect(res.status).toBe(200);
    const list = res.body as Array<{ id: string; name: string }>;
    const ids = list.map((c) => c.id);
    expect(ids).toContain("cat-1");
    expect(ids).toContain("cat-2");
    expect(ids).not.toContain("cat-other");
  });

  it("does not leak another user's categories even if ids overlap", async () => {
    seedCategory("cat-1", OTHER_USER_ID, "private");
    const res = await authedGet("/api/categories");
    const list = res.body as Array<{ id: string; name: string }>;
    expect(list.find((c) => c.id === "cat-1")).toBeUndefined();
  });
});

describe("POST /api/categories", () => {
  it("returns 403 from CSRF middleware without auth and without CSRF token", async () => {
    const res = await request(app, "/api/categories", {
      method: "POST",
      headers: noAuthHeaders(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("creates a category and returns 201", async () => {
    const res = await authedPost("/api/categories", { name: "research" });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; name: string; ownerId: string };
    expect(body.name).toBe("research");
    expect(body.ownerId).toBe(OWNER_ID);
    expect(body.id).toBeTruthy();
  });

  it("rejects an empty name with 400", async () => {
    const res = await authedPost("/api/categories", { name: "" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("rejects a too-long name with 400", async () => {
    const res = await authedPost("/api/categories", { name: "x".repeat(256) });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("trims surrounding whitespace from the name", async () => {
    const res = await authedPost("/api/categories", { name: "  trimmed  " });
    expect(res.status).toBe(201);
    expect((res.body as any).name).toBe("trimmed");
  });

  it("returns 409 on a duplicate name within the same user", async () => {
    seedCategory("cat-1", OWNER_ID, "duplicate");
    const res = await authedPost("/api/categories", { name: "duplicate" });
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe(
      "Category with this name already exists",
    );
  });

  it("allows the same name across different users", async () => {
    seedCategory("cat-other", OTHER_USER_ID, "shared-name");
    const res = await authedPost("/api/categories", { name: "shared-name" });
    expect(res.status).toBe(201);
    expect((res.body as any).name).toBe("shared-name");
  });
});

describe("PATCH /api/categories/:id", () => {
  it("updates the name and returns 200", async () => {
    seedCategory("cat-1", OWNER_ID, "old");
    const res = await authedPatch("/api/categories/cat-1", {
      name: "new-name",
    });
    expect(res.status).toBe(200);
    expect((res.body as any).name).toBe("new-name");
    expect(getState().categories.get("cat-1")?.name).toBe("new-name");
  });

  it("returns 404 when the id is unknown", async () => {
    const res = await authedPatch("/api/categories/missing-id", {
      name: "anything",
    });
    expect(res.status).toBe(404);
    expect((res.body as any).error).toBe("Category not found");
  });

  it("returns 404 when patching another user's category", async () => {
    seedCategory("cat-other", OTHER_USER_ID, "private");
    const res = await authedPatch("/api/categories/cat-other", {
      name: "hijacked",
    });
    expect(res.status).toBe(404);
    // Confirm the other user's name was NOT mutated
    expect(getState().categories.get("cat-other")?.name).toBe("private");
  });

  it("returns 400 when the body is empty", async () => {
    seedCategory("cat-1", OWNER_ID, "stable");
    const res = await authedPatch("/api/categories/cat-1", {});
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe(
      "At least one field (name, order, or API access setting) is required",
    );
  });

  it("returns 409 when renaming to a name that already exists", async () => {
    seedCategory("cat-1", OWNER_ID, "first");
    seedCategory("cat-2", OWNER_ID, "second");
    const res = await authedPatch("/api/categories/cat-1", {
      name: "second",
    });
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe(
      "Category with this name already exists",
    );
  });

  it("allows renaming to the same name (idempotent)", async () => {
    seedCategory("cat-1", OWNER_ID, "stable");
    const res = await authedPatch("/api/categories/cat-1", {
      name: "stable",
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/categories/:id", () => {
  it("deletes the category and returns 200", async () => {
    seedCategory("cat-1", OWNER_ID, "transient");
    const res = await authedDelete("/api/categories/cat-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(getState().categories.has("cat-1")).toBe(false);
  });

  it("returns 404 when the id is unknown", async () => {
    const res = await authedDelete("/api/categories/missing");
    expect(res.status).toBe(404);
    expect((res.body as any).error).toBe("Category not found");
  });

  it("returns 404 when deleting another user's category", async () => {
    seedCategory("cat-other", OTHER_USER_ID, "private");
    const res = await authedDelete("/api/categories/cat-other");
    expect(res.status).toBe(404);
    // The other user's category must remain intact.
    expect(getState().categories.has("cat-other")).toBe(true);
  });
});
