/**
 * HTTP-level tests for folder routes.
 * Tests: GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
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
  API_KEY,
  getState,
  noAuthHeaders,
	OWNER_ID,
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

describe("GET /api/folders", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app, "/api/folders", {
      method: "GET",
      headers: noAuthHeaders(),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 200 with empty array when no folders", async () => {
    const res = await authedGet("/api/folders");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns root-level folders for the current user", async () => {
    const state = getState();
    state.folders.set("folder-1", {
      id: "folder-1",
      ownerId: OWNER_ID,
      name: "Engineering",
      parentId: null,
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    });
    state.folders.set("folder-2", {
      id: "folder-2",
      ownerId: OWNER_ID,
      name: "Design",
      parentId: null,
      createdAt: new Date("2024-01-02"),
      updatedAt: new Date("2024-01-02"),
    });
    state.folders.set("folder-3", {
      id: "folder-3",
      ownerId: "other-user",
      name: "Should not appear",
      parentId: null,
    });

    const res = await authedGet("/api/folders");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const items = res.body as Array<{ id: string; name: string }>;
    const ids = items.map((f) => f.id);
    expect(ids).toContain("folder-1");
    expect(ids).toContain("folder-2");
    expect(ids).not.toContain("folder-3");
  });

  it("filters by parentId when provided", async () => {
    const state = getState();
    state.folders.set("parent", {
      id: "parent",
      ownerId: OWNER_ID,
      name: "Parent",
      parentId: null,
    });
    state.folders.set("child-1", {
      id: "child-1",
      ownerId: OWNER_ID,
      name: "Child 1",
      parentId: "parent",
    });
    state.folders.set("child-2", {
      id: "child-2",
      ownerId: OWNER_ID,
      name: "Child 2",
      parentId: "parent",
    });

    const res = await authedGet("/api/folders?parentId=parent");
    expect(res.status).toBe(200);
    const items = res.body as Array<{ id: string }>;
    const ids = items.map((f) => f.id);
    expect(ids).toContain("child-1");
    expect(ids).toContain("child-2");
    expect(ids).not.toContain("parent");
  });
});

describe("GET /api/folders/:id", () => {
  it("returns 404 for unknown folder", async () => {
    const res = await authedGet(
      "/api/folders/00000000-0000-4000-8000-000000000099",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Folder not found" });
  });

  it("returns 200 for owned folder", async () => {
    const state = getState();
    const id = "11111111-1111-4111-8111-111111111111";
    state.folders.set(id, {
      id,
      ownerId: OWNER_ID,
      name: "My Folder",
      parentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await authedGet(`/api/folders/${id}`);
    expect(res.status).toBe(200);
    expect((res.body as any).id).toBe(id);
    expect((res.body as any).name).toBe("My Folder");
  });

  it("returns document metadata without loading document bodies", async () => {
    const state = getState();
    const id = "11111111-1111-4111-8111-111111111112";
    const documentId = "22222222-2222-4222-8222-222222222222";
    state.folders.set(id, {
      id,
      ownerId: OWNER_ID,
      name: "Large documents",
      parentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    state.documents.set(documentId, {
      id: documentId,
      ownerId: OWNER_ID,
      folderId: id,
      categoryId: null,
      title: "Large import",
      content: "A".repeat(2_000_000),
      contentJson: null,
      visibility: "private",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await authedGet(`/api/folders/${id}`);
    expect(res.status).toBe(200);
    const [document] = (res.body as any).documents;
    expect(document.id).toBe(documentId);
    expect(document.title).toBe("Large import");
		expect(document.content).toHaveLength(200);
    expect(document).not.toHaveProperty("contentJson");
  });
});

describe("POST /api/folders", () => {
	const CATEGORY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const CATEGORY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

	function addCategory(id: string, name: string) {
		getState().categories.set(id, { id, ownerId: OWNER_ID, name });
	}
  it("returns 403 from CSRF middleware on POST without Bearer or CSRF token", async () => {
    const res = await request(app, "/api/folders", {
      method: "POST",
      headers: noAuthHeaders(),
      body: JSON.stringify({ name: "Test" }),
    });
    expect(res.status).toBe(403);
    expect((res.body as any).error).toMatch(/CSRF/i);
  });

  it("returns 400 for invalid body", async () => {
    const res = await authedPost("/api/folders", { name: "" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("creates a folder and returns 201", async () => {
    const res = await authedPost("/api/folders", { name: "Engineering" });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; name: string; ownerId: string };
    expect(body.name).toBe("Engineering");
    expect(body.ownerId).toBe(OWNER_ID);
    expect(body.id).toBeTruthy();

    // Verify the folder is in the state
    const state = getState();
    const stored = Array.from(state.folders.values()).find(
      (f) => f.id === body.id,
    );
    expect(stored).toBeTruthy();
    expect((stored as any).name).toBe("Engineering");
  });

  it("returns 404 when parentId refers to a non-existent folder", async () => {
    const res = await authedPost("/api/folders", {
      name: "Child",
      parentId: "00000000-0000-4000-8000-000000000099",
    });
    expect(res.status).toBe(404);
    expect((res.body as any).error).toBe("Parent folder not found");
  });

  it("creates a child folder under a valid parent", async () => {
    const state = getState();
    const parentId = "22222222-2222-4222-8222-222222222222";
    state.folders.set(parentId, {
      id: parentId,
      ownerId: OWNER_ID,
      name: "Parent",
      parentId: null,
    });

    const res = await authedPost("/api/folders", {
      name: "Child",
      parentId,
    });
    expect(res.status).toBe(201);
    expect((res.body as any).parentId).toBe(parentId);
  });

	it("numbers duplicate uncategorized root folders and fills suffix gaps", async () => {
		for (const name of ["Plans", "Plans 2", "Plans 4"]) {
			const created = await authedPost("/api/folders", { name });
			expect(created.status).toBe(201);
		}
		const duplicate = await authedPost("/api/folders", { name: "Plans" });
		expect(duplicate.status).toBe(201);
		expect((duplicate.body as any).name).toBe("Plans 3");
	});

	it("numbers duplicates only within the same category scope", async () => {
		addCategory(CATEGORY_A, "Category A");
		addCategory(CATEGORY_B, "Category B");

		const firstA = await authedPost("/api/folders", {
			name: "Assets",
			categoryId: CATEGORY_A,
		});
		const secondA = await authedPost("/api/folders", {
			name: "Assets",
			categoryId: CATEGORY_A,
		});
		const firstB = await authedPost("/api/folders", {
			name: "Assets",
			categoryId: CATEGORY_B,
		});

		expect((firstA.body as any).name).toBe("Assets");
		expect((firstA.body as any).categoryId).toBe(CATEGORY_A);
		expect((secondA.body as any).name).toBe("Assets 2");
		expect((firstB.body as any).name).toBe("Assets");
	});

	it("numbers duplicates only within the same parent scope", async () => {
		const state = getState();
		const parentA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const parentB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		state.folders.set(parentA, {
			id: parentA,
			ownerId: OWNER_ID,
			name: "A",
			parentId: null,
		});
		state.folders.set(parentB, {
			id: parentB,
			ownerId: OWNER_ID,
			name: "B",
			parentId: null,
		});

		const firstA = await authedPost("/api/folders", {
			name: "Drafts",
			parentId: parentA,
		});
		const secondA = await authedPost("/api/folders", {
			name: "Drafts",
			parentId: parentA,
		});
		const firstB = await authedPost("/api/folders", {
			name: "Drafts",
			parentId: parentB,
		});

		expect((firstA.body as any).name).toBe("Drafts");
		expect((secondA.body as any).name).toBe("Drafts 2");
		expect((firstB.body as any).name).toBe("Drafts");
	});

	it("rejects an unknown category", async () => {
		const res = await authedPost("/api/folders", {
			name: "Plans",
			categoryId: CATEGORY_A,
		});
		expect(res.status).toBe(404);
		expect(res.body).toEqual({ error: "Category not found" });
	});
});

describe("PATCH /api/folders/:id", () => {
  it("returns 404 for unknown folder", async () => {
    const res = await authedPatch(
      "/api/folders/00000000-0000-4000-8000-000000000099",
      { name: "Renamed" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when no fields provided", async () => {
    const state = getState();
    const id = "33333333-3333-4333-8333-333333333333";
    state.folders.set(id, {
      id,
      ownerId: OWNER_ID,
      name: "Old",
      parentId: null,
    });

    const res = await authedPatch(`/api/folders/${id}`, {});
    expect(res.status).toBe(400);
    expect((res.body as any).error).toMatch(/at least one field/i);
  });

  it("renames a folder", async () => {
    const state = getState();
    const id = "44444444-4444-4444-8444-444444444444";
    state.folders.set(id, {
      id,
      ownerId: OWNER_ID,
      name: "Old Name",
      parentId: null,
    });

    const res = await authedPatch(`/api/folders/${id}`, {
      name: "New Name",
    });
    expect(res.status).toBe(200);
    expect((res.body as any).name).toBe("New Name");

    const stored = (state.folders.get(id) as any).name;
    expect(stored).toBe("New Name");
  });

  it("rejects setting folder as its own parent", async () => {
    const state = getState();
    const id = "55555555-5555-4555-8555-555555555555";
    state.folders.set(id, {
      id,
      ownerId: OWNER_ID,
      name: "Loop",
      parentId: null,
    });

    const res = await authedPatch(`/api/folders/${id}`, {
      parentId: id,
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toMatch(/cannot be its own parent/);
  });

  it("rejects moving a folder into its descendant", async () => {
    const state = getState();
    const parentId = "66666666-6666-4666-8666-666666666666";
    const childId = "77777777-7777-4777-8777-777777777777";
    state.folders.set(parentId, {
      id: parentId,
      ownerId: OWNER_ID,
      name: "Parent",
      parentId: null,
    });
    state.folders.set(childId, {
      id: childId,
      ownerId: OWNER_ID,
      name: "Child",
      parentId,
    });

    const res = await authedPatch(`/api/folders/${parentId}`, {
      parentId: childId,
    });

    expect(res.status).toBe(400);
    expect((res.body as any).error).toMatch(/descendant/);
    expect((state.folders.get(parentId) as any).parentId).toBeNull();
  });

  it("moves a sibling folder under another owned folder", async () => {
    const state = getState();
    const folderId = "88888888-8888-4888-8888-888888888888";
    const parentId = "99999999-9999-4999-8999-999999999999";
    state.folders.set(folderId, {
      id: folderId,
      ownerId: OWNER_ID,
      name: "Movable",
      parentId: null,
    });
    state.folders.set(parentId, {
      id: parentId,
      ownerId: OWNER_ID,
      name: "Destination",
      parentId: null,
    });

    const res = await authedPatch(`/api/folders/${folderId}`, { parentId });

    expect(res.status).toBe(200);
    expect((res.body as any).parentId).toBe(parentId);
    expect((res.body as any).categoryId).toBeNull();
  });
});

describe("DELETE /api/folders/:id", () => {
  it("returns 404 for unknown folder", async () => {
    const res = await authedDelete(
      "/api/folders/00000000-0000-4000-8000-000000000099",
    );
    expect(res.status).toBe(404);
  });

  it("deletes an owned folder", async () => {
    const state = getState();
    const id = "66666666-6666-4666-8666-666666666666";
    state.folders.set(id, {
      id,
      ownerId: OWNER_ID,
      name: "Trash Me",
      parentId: null,
    });

    const res = await authedDelete(`/api/folders/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(state.folders.has(id)).toBe(false);
  });

  it("does not delete a folder owned by another user", async () => {
    const state = getState();
    const id = "77777777-7777-4777-8777-777777777777";
    state.folders.set(id, {
      id,
      ownerId: "another-user-uuid",
      name: "Other's Folder",
      parentId: null,
    });

    const res = await authedDelete(`/api/folders/${id}`);
    expect(res.status).toBe(404);
    expect(state.folders.has(id)).toBe(true);
  });
});

describe("Folder API auth integration", () => {
  it("uses OWNER_ID when the test API key is presented", async () => {
    const create = await authedPost("/api/folders", { name: "API Key Flow" });
    expect(create.status).toBe(201);
    expect((create.body as any).ownerId).toBe(OWNER_ID);

    const list = await authedGet("/api/folders");
    expect(list.status).toBe(200);
    const items = list.body as Array<{ id: string }>;
    expect(items.find((f) => f.id === (create.body as any).id)).toBeTruthy();
  });
});
