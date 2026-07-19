/**
 * HTTP-level tests for document routes.
 * Tests: GET /api/documents, GET /api/documents/:id,
 *        POST /api/documents, PATCH /api/documents/:id,
 *        DELETE /api/documents/:id
 *
 * Uses the shared integration harness for the mock infrastructure. Adds a
 * temporary `as()` shim on Object.prototype so the document list query's
 * `sql\`LEFT(...)\`.as("content")` call works against the harness's
 * `sql` mock (which returns a plain object without `.as()`).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  OWNER_ID,
  OTHER_USER_ID,
  getState,
  noAuthHeaders,
  ownerHeaders,
  request,
  resetState,
  setupHarness,
} from "./_harness";

// The harness's `sql` mock returns plain `{ [Symbol(sql)]: true }` objects
// without an `.as()` method. The document list query does
// `sql\`LEFT(${documents.content}, 200)\`.as("content")` — calling `.as()`
// on a plain object throws. Install a no-op `.as()` on Object.prototype
// for the lifetime of this test file and remove it in afterAll so it
// doesn't leak into other test files.
(Object.prototype as any).as = function (this: any) {
  return this;
};

let app: any;

beforeAll(async () => {
  const built = await setupHarness();
  app = built.app;
});

afterAll(() => {
  delete (Object.prototype as any).as;
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

function seedDocument(overrides: Partial<any> = {}): any {
  const now = new Date("2024-06-01T00:00:00Z");
  const doc = {
    id: "00000000-0000-4000-8000-000000000000",
    ownerId: OWNER_ID,
    folderId: null,
    title: "Seeded Doc",
    content: "hello world",
    contentJson: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  getState().documents.set(doc.id, doc);
  return doc;
}

describe("GET /api/documents", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app, "/api/documents", {
      method: "GET",
      headers: noAuthHeaders(),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 200 with empty items when no documents exist", async () => {
    const res = await authedGet("/api/documents");
    expect(res.status).toBe(200);
    expect((res.body as any).items).toEqual([]);
    expect((res.body as any).page).toBe(1);
    expect((res.body as any).limit).toBe(20);
  });

  it("returns only the current user's documents", async () => {
    seedDocument({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Mine A",
    });
    seedDocument({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Mine B",
    });
    seedDocument({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Theirs",
      ownerId: OTHER_USER_ID,
    });

    const res = await authedGet("/api/documents");
    expect(res.status).toBe(200);
    const items = (res.body as any).items as Array<{
      id: string;
      title: string;
    }>;
    const ids = items.map((d) => d.id);
    expect(ids).toContain("11111111-1111-4111-8111-111111111111");
    expect(ids).toContain("22222222-2222-4222-8222-222222222222");
    expect(ids).not.toContain("33333333-3333-4333-8333-333333333333");
  });

  it("respects the page and limit query parameters", async () => {
    for (let i = 0; i < 5; i++) {
      seedDocument({
        id: `${i.toString().padStart(8, "0")}-0000-4000-8000-000000000000`,
        title: `Doc ${i}`,
      });
    }

    const res = await authedGet("/api/documents?page=2&limit=2");
    expect(res.status).toBe(200);
    expect((res.body as any).page).toBe(2);
    expect((res.body as any).limit).toBe(2);
    expect(((res.body as any).items as any[]).length).toBe(2);
  });

  it("rejects limit above 1000", async () => {
    const res = await authedGet("/api/documents?limit=1001");
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid query");
  });

  it("rejects a non-uuid folderId filter", async () => {
    const res = await authedGet("/api/documents?folderId=not-a-uuid");
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid query");
  });

  it("filters by folderId when provided", async () => {
    const folderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    seedDocument({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "In folder",
      folderId,
    });
    seedDocument({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      title: "Outside folder",
      folderId: null,
    });

    const res = await authedGet(`/api/documents?folderId=${folderId}`);
    expect(res.status).toBe(200);
    const items = (res.body as any).items as Array<{ id: string }>;
    const ids = items.map((d) => d.id);
    expect(ids).toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(ids).not.toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });
});

describe("GET /api/documents/cursor", () => {
	it("enforces the bounded limit contract and rejects malformed cursors", async () => {
		const invalidLimit = await authedGet("/api/documents/cursor?limit=101");
		expect(invalidLimit.status).toBe(400);

		const malformed = await authedGet(
			"/api/documents/cursor?cursor=not-base64url-json",
		);
		expect(malformed.status).toBe(400);
		expect((malformed.body as any).error).toContain("Malformed cursor");
	});

	it("uses updatedAt DESC and id DESC and paginates timestamp ties without duplicates", async () => {
		const updatedAt = new Date("2026-07-16T12:00:00.000Z");
		const ids = [
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
			"33333333-3333-4333-8333-333333333333",
		];
		for (const id of ids) seedDocument({ id, updatedAt });

		const first = await authedGet("/api/documents/cursor?limit=2");
		expect(first.status).toBe(200);
		const firstBody = first.body as any;
		expect(firstBody.items.map((item: any) => item.id)).toEqual([
			ids[2],
			ids[1],
		]);
		expect(typeof firstBody.nextCursor).toBe("string");

		const second = await authedGet(
			`/api/documents/cursor?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
		);
		expect(second.status).toBe(200);
		const secondBody = second.body as any;
		expect(secondBody.items.map((item: any) => item.id)).toEqual([ids[0]]);
		expect(secondBody.nextCursor).toBeNull();
	});

	it("binds a cursor to the category scope", async () => {
		const firstCategory = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const secondCategory = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		for (let index = 0; index < 2; index += 1) {
			seedDocument({
				id: `${index + 1}0000000-0000-4000-8000-000000000000`,
				categoryId: firstCategory,
				updatedAt: new Date(1_700_000_000_000 - index),
			});
		}

		const first = await authedGet(
			`/api/documents/cursor?limit=1&categoryId=${firstCategory}`,
		);
		expect(first.status).toBe(200);
		const cursor = (first.body as any).nextCursor;
		expect(typeof cursor).toBe("string");

		const crossScope = await authedGet(
			`/api/documents/cursor?limit=1&categoryId=${secondCategory}&cursor=${encodeURIComponent(cursor)}`,
		);
		expect(crossScope.status).toBe(400);
		expect((crossScope.body as any).error).toBe(
			"Cursor does not match this listing scope",
		);
	});
});

describe("GET /api/documents/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const res = await authedGet(
      "/api/documents/00000000-0000-4000-8000-000000000099",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Document not found" });
  });

  it("returns 200 with the document and tags for an owned doc", async () => {
    const doc = seedDocument({
      id: "44444444-4444-4444-8444-444444444444",
      title: "My Doc",
    });

    const res = await authedGet(`/api/documents/${doc.id}`);
    expect(res.status).toBe(200);
    expect((res.body as any).id).toBe(doc.id);
    expect((res.body as any).title).toBe("My Doc");
    expect((res.body as any).ownerId).toBe(OWNER_ID);
    expect(Array.isArray((res.body as any).tags)).toBe(true);
  });

  it("returns 404 for a document owned by another user", async () => {
    seedDocument({
      id: "55555555-5555-4555-8555-555555555555",
      title: "Other's Doc",
      ownerId: OTHER_USER_ID,
    });

    const res = await authedGet(
      "/api/documents/55555555-5555-4555-8555-555555555555",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Document not found" });
  });

  it("returns 401 with an invalid bearer token", async () => {
    const doc = seedDocument({ id: "66666666-6666-4666-8666-666666666666" });
    const res = await request(app, `/api/documents/${doc.id}`, {
      method: "GET",
      headers: {
        authorization: "Bearer wrong-api-key",
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/documents/:id/pipeline", () => {
	it("requires authentication", async () => {
		const res = await request(app, "/api/documents/doc-1/pipeline", {
			method: "GET",
			headers: noAuthHeaders(),
		});
		expect(res.status).toBe(401);
	});

	it("returns only the owner's latest pipeline progress", async () => {
		seedDocument({ id: "doc-pipeline", ownerId: OWNER_ID, title: "pipeline" });
		getState().pipelineRuns.set("run-old", {
			documentId: "doc-pipeline", ownerId: OWNER_ID, generationId: "gen-old",
			revision: "rev-old", status: "ready", prepareStatus: "ready", embedStatus: "ready",
			graphStatus: "skipped", summarizeStatus: "skipped", finalizeStatus: "ready",
			totalBatches: 1, completedBatches: 1, failedBatches: 0,
			updatedAt: new Date("2026-01-01"),
		});
		getState().pipelineRuns.set("run-new", {
			documentId: "doc-pipeline", ownerId: OWNER_ID, generationId: "gen-new",
			revision: "rev-new", status: "processing", prepareStatus: "ready", embedStatus: "processing",
			graphStatus: "pending", summarizeStatus: "pending", finalizeStatus: "pending",
			totalBatches: 2, completedBatches: 1, failedBatches: 0,
			updatedAt: new Date("2026-01-02"),
		});
		getState().pipelineRuns.set("run-other", {
			documentId: "doc-pipeline", ownerId: OTHER_USER_ID, generationId: "gen-other",
			revision: "rev-other", status: "ready", updatedAt: new Date("2026-01-03"),
		});
		const res = await authedGet("/api/documents/doc-pipeline/pipeline");
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ generationId: "gen-new", status: "processing", batches: { completed: 1, total: 2 } });
	});
});

describe("POST /api/documents", () => {
  it("returns 403 from CSRF middleware on POST without Bearer or CSRF token", async () => {
    const res = await request(app, "/api/documents", {
      method: "POST",
      headers: noAuthHeaders(),
      body: JSON.stringify({ title: "Test" }),
    });
    expect(res.status).toBe(403);
    expect((res.body as any).error).toMatch(/CSRF/i);
  });

  it("returns 400 when title is empty", async () => {
    const res = await authedPost("/api/documents", { title: "" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("returns 400 when title exceeds 500 chars", async () => {
    const res = await authedPost("/api/documents", { title: "a".repeat(501) });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("returns 400 for an invalid folderId", async () => {
    const res = await authedPost("/api/documents", {
      title: "Bad folder",
      folderId: "not-a-uuid",
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("creates a document and returns 201", async () => {
    const res = await authedPost("/api/documents", {
      title: "My first doc",
      content: "# Hello",
    });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; title: string; ownerId: string };
    expect(body.title).toBe("My first doc");
    expect(body.ownerId).toBe(OWNER_ID);
    expect(body.id).toBeTruthy();

    // Verify the document is in the state
    const stored = getState().documents.get(body.id);
    expect(stored).toBeTruthy();
    expect((stored as any).title).toBe("My first doc");
    expect((stored as any).ownerId).toBe(OWNER_ID);

    // Embedding should have been enqueued
    expect(getState().enqueuedEmbeddings).toContain(body.id);
  });

  it("defaults the title to 'Untitled' when omitted", async () => {
    const res = await authedPost("/api/documents", {});
    expect(res.status).toBe(201);
    expect((res.body as any).title).toBe("Untitled");
  });

  it("returns 401 with an invalid bearer token", async () => {
    const res = await request(app, "/api/documents", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Nope" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/documents/:id", () => {
  it("returns 404 for an unknown document", async () => {
    const res = await authedPatch(
      "/api/documents/00000000-0000-4000-8000-000000000099",
      { title: "Renamed" },
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Document not found" });
  });

  it("returns 400 when no fields are provided", async () => {
    const doc = seedDocument({ id: "77777777-7777-4777-8777-777777777777" });
    const res = await authedPatch(`/api/documents/${doc.id}`, {});
    expect(res.status).toBe(400);
    expect((res.body as any).error).toMatch(/at least one field/i);
  });

  it("returns 400 for an invalid title", async () => {
    const doc = seedDocument({ id: "88888888-8888-4888-8888-888888888888" });
    const res = await authedPatch(`/api/documents/${doc.id}`, { title: "" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("renames a document", async () => {
    const doc = seedDocument({
      id: "99999999-9999-4999-8999-999999999999",
      title: "Old",
    });

    const res = await authedPatch(`/api/documents/${doc.id}`, {
      title: "New",
    });
    expect(res.status).toBe(200);
    expect((res.body as any).title).toBe("New");

    const stored = getState().documents.get(doc.id) as any;
    expect(stored.title).toBe("New");
  });

  it("updates when expectedUpdatedAt matches the server timestamp", async () => {
    const doc = seedDocument({
      id: "99999999-9999-4999-8999-999999999998",
      title: "Old",
      updatedAt: new Date("2024-06-01T00:00:00.000Z"),
    });

    const res = await authedPatch(`/api/documents/${doc.id}`, {
      title: "New",
      expectedUpdatedAt: doc.updatedAt.toISOString(),
    });
    expect(res.status).toBe(200);
    expect((res.body as any).title).toBe("New");
  });

  it("returns a structured 409 conflict without version or update side effects", async () => {
    const doc = seedDocument({
      id: "99999999-9999-4999-8999-999999999997",
      title: "Server title",
      content: "Server body",
      contentJson: { type: "doc" },
      updatedAt: new Date("2024-06-01T00:00:00.000Z"),
    });

    const res = await authedPatch(`/api/documents/${doc.id}`, {
      title: "Local title",
      expectedUpdatedAt: "2024-05-31T00:00:00.000Z",
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Document changed on the server",
      code: "DOCUMENT_CONFLICT",
      currentUpdatedAt: doc.updatedAt.toISOString(),
      serverVersion: {
        id: doc.id,
        title: "Server title",
        content: "Server body",
        contentJson: { type: "doc" },
      },
    });
    expect(getState().documents.get(doc.id)).toMatchObject({ title: "Server title" });
    expect(getState().versions).toHaveLength(0);
    expect(getState().enqueuedEmbeddings).not.toContain(doc.id);
  });

  it("rejects an expectedUpdatedAt value without an explicit timezone", async () => {
    const doc = seedDocument({ id: "99999999-9999-4999-8999-999999999996" });
    const res = await authedPatch(`/api/documents/${doc.id}`, {
      title: "New",
      expectedUpdatedAt: "2024-06-01T00:00:00",
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid input");
  });

  it("updates content and re-enqueues embedding", async () => {
    const doc = seedDocument({
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Keep",
      content: "old body",
    });

    const res = await authedPatch(`/api/documents/${doc.id}`, {
      content: "new body",
    });
    expect(res.status).toBe(200);

    const stored = getState().documents.get(doc.id) as any;
    expect(stored.content).toBe("new body");

    // Embedding should have been re-enqueued
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getState().enqueuedEmbeddings).toContain(doc.id);
  });

  it("moves a document to a different folder", async () => {
    const doc = seedDocument({
      id: "abcdef00-0000-4000-8000-000000000000",
      folderId: null,
    });
    const newFolder = "abcdef01-0000-4000-8000-000000000000";

    const res = await authedPatch(`/api/documents/${doc.id}`, {
      folderId: newFolder,
    });
    expect(res.status).toBe(200);
    expect((res.body as any).folderId).toBe(newFolder);
  });

  it("invalidates the cached list before acknowledging a placement update", async () => {
    const doc = seedDocument({
      id: "abcdef03-0000-4000-8000-000000000000",
      folderId: null,
      categoryId: null,
    });
    const newFolder = "abcdef04-0000-4000-8000-000000000000";
    const newCategory = "abcdef05-0000-4000-8000-000000000000";

    const before = await authedGet("/api/documents?limit=100");
    expect(before.status).toBe(200);
    expect(
      (before.body as any).items.find((item: any) => item.id === doc.id)
        .folderId,
    ).toBeNull();

    const moved = await authedPatch(`/api/documents/${doc.id}`, {
      folderId: newFolder,
      categoryId: newCategory,
    });
    expect(moved.status).toBe(200);

    const after = await authedGet("/api/documents?limit=100");
    const listed = (after.body as any).items.find(
      (item: any) => item.id === doc.id,
    );
    expect(listed.folderId).toBe(newFolder);
    expect(listed.categoryId).toBe(newCategory);
  });

  it("returns 404 when updating a document owned by another user", async () => {
    seedDocument({
      id: "abcdef02-0000-4000-8000-000000000000",
      ownerId: OTHER_USER_ID,
    });
    const res = await authedPatch(
      "/api/documents/abcdef02-0000-4000-8000-000000000000",
      { title: "X" },
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Document not found" });
  });
});

describe("DELETE /api/documents/:id", () => {
  it("returns 404 for an unknown document", async () => {
    const res = await authedDelete(
      "/api/documents/00000000-0000-4000-8000-000000000099",
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Document not found" });
  });

  it("deletes an owned document", async () => {
    const doc = seedDocument({ id: "deadbeef-0000-4000-8000-000000000000" });
    const res = await authedDelete(`/api/documents/${doc.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
		expect(getState().documents.get(doc.id)?.deletedAt).toBeInstanceOf(Date);
  });

  it("does not delete a document owned by another user", async () => {
    const doc = seedDocument({
      id: "deadbee1-0000-4000-8000-000000000000",
      ownerId: OTHER_USER_ID,
    });
    const res = await authedDelete(`/api/documents/${doc.id}`);
    expect(res.status).toBe(404);
    expect(getState().documents.has(doc.id)).toBe(true);
  });

  it("returns 401 with an invalid bearer token", async () => {
    const doc = seedDocument({ id: "deadbee2-0000-4000-8000-000000000000" });
    const res = await request(app, `/api/documents/${doc.id}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer wrong-api-key",
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(401);
  });
});

describe("Document API auth integration", () => {
  it("uses OWNER_ID when the test API key is presented", async () => {
    const create = await authedPost("/api/documents", {
      title: "API key flow",
    });
    expect(create.status).toBe(201);
    expect((create.body as any).ownerId).toBe(OWNER_ID);

    const list = await authedGet("/api/documents");
    expect(list.status).toBe(200);
    const items = (list.body as any).items as Array<{ id: string }>;
    const found = items.find((d) => d.id === (create.body as any).id);
    expect(found).toBeTruthy();
  });

  it("rejects a wrong Bearer token with 401", async () => {
    const res = await request(app, "/api/documents", {
      method: "GET",
      headers: {
        authorization: "Bearer wrong-api-key",
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(401);
  });
});
