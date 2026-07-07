/**
 * HTTP-level tests for the attachment DELETE endpoint.
 *
 * Endpoint:
 *   DELETE /api/attachments/:id
 *
 * Tests:
 *   - 401 with an invalid bearer token.
 *   - 404 for an unknown attachment id.
 *   - 403 when the attachment is owned by a different user.
 *   - 200 + DB row removed + storage key removed for the owner.
 *   - DB row is still removed when storage throws on removeObject (best-effort).
 *
 * Note: the harness's mock db does not process `innerJoin`, so the test
 * seeds the attachment row with an `ownerId` field directly. The route
 * code selects `ownerId` from the documents table via the join; in the
 * in-memory mock, the `applyFieldSelection` step reads the same key off
 * the row, so the seeded `ownerId` is what the route observes.
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
  getStorageMockState,
  getState,
  noAuthHeaders,
  ownerHeaders,
  request,
  resetState,
  setupHarness,
} from "./_harness";

let app: any;

const DOC_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_DOC_ID = "00000000-0000-4000-8000-0000000000bb";
const ATTACHMENT_ID = "00000000-0000-4000-8000-0000000000cc";
const STORAGE_KEY = `${OWNER_ID}/${DOC_ID}/seeded.png`;

function seedAttachment(
  opts: {
    id?: string;
    ownerId?: string;
    documentId?: string;
    storageKey?: string;
  } = {},
) {
  const id = opts.id ?? ATTACHMENT_ID;
  // Pre-seed a document so the production JOIN finds a row to resolve
  // `ownerId` from. The harness ignores the join, but seeding both
  // keeps the in-memory state representative of what the real DB
  // would return.
  getState().documents.set(opts.documentId ?? DOC_ID, {
    id: opts.documentId ?? DOC_ID,
    ownerId: opts.ownerId ?? OWNER_ID,
    title: "Test doc",
    folderId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    contentJson: null,
    content: "",
    categoryId: null,
  });
  getState().attachments.set(id, {
    id,
    documentId: opts.documentId ?? DOC_ID,
    filename: "seeded.png",
    mimeType: "image/png",
    size: 1024,
    storageKey: opts.storageKey ?? STORAGE_KEY,
    // Mirrors the `ownerId` the production code reads off the
    // joined documents row. The harness's applyFieldSelection
    // reads this key directly off the attachments row because
    // the mock db does not process innerJoin.
    ownerId: opts.ownerId ?? OWNER_ID,
  });
  return id;
}

beforeAll(async () => {
  const built = await setupHarness();
  app = built.app;
});

beforeEach(() => {
  resetState();
  // Reset storage mock to the happy path. Individual tests that simulate
  // failures flip the flags and reset them themselves so they never
  // leak into siblings.
  getStorageMockState().statObjectShouldThrow = false;
  getStorageMockState().removeObjectShouldThrow = false;
  getStorageMockState().removedKeys.length = 0;
});

afterEach(() => {
  resetState();
  getStorageMockState().statObjectShouldThrow = false;
  getStorageMockState().removeObjectShouldThrow = false;
  getStorageMockState().removedKeys.length = 0;
});

describe("DELETE /api/attachments/:id", () => {
  it("returns 401 with an invalid bearer token", async () => {
    seedAttachment();
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer not-a-valid-key",
      },
    });
    expect(res.status).toBe(401);
    // The DB row and storage object should both be untouched.
    expect(getState().attachments.size).toBe(1);
    expect(getStorageMockState().removedKeys).toEqual([]);
  });

  it("returns 403 without auth (CSRF blocks first)", async () => {
    seedAttachment();
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}`, {
      method: "DELETE",
      headers: noAuthHeaders(),
    });
    expect(res.status).toBe(403);
    expect(getState().attachments.size).toBe(1);
  });

  it("returns 404 for an unknown attachment id", async () => {
    seedAttachment(); // exists, but we'll ask for a different id
    const res = await request(app, "/api/attachments/does-not-exist", {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(404);
    expect(getState().attachments.size).toBe(1);
    expect(getStorageMockState().removedKeys).toEqual([]);
  });

  it("returns 403 when the attachment belongs to another user", async () => {
    seedAttachment({ ownerId: OTHER_USER_ID, documentId: OTHER_DOC_ID });
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(403);
    // The other user's row and object must remain intact.
    expect(getState().attachments.size).toBe(1);
    expect(getStorageMockState().removedKeys).toEqual([]);
  });

  it("deletes the DB row and removes the storage object for the owner", async () => {
    seedAttachment();
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(getState().attachments.has(ATTACHMENT_ID)).toBe(false);
    expect(getStorageMockState().removedKeys).toEqual([STORAGE_KEY]);
  });

  it("still deletes the DB row if storage removeObject throws", async () => {
    seedAttachment();
    getStorageMockState().removeObjectShouldThrow = true;
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    // The 200 is what the user sees; the storage failure is logged
    // and surfaced as a follow-up cleanup task, not as an error
    // to the caller.
    expect(res.status).toBe(200);
    expect(getState().attachments.has(ATTACHMENT_ID)).toBe(false);
    // removeObject was attempted (and threw) before the DB delete.
    expect(getStorageMockState().removedKeys).toEqual([STORAGE_KEY]);
  });
});
