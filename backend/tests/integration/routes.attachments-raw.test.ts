/**
 * HTTP-level tests for the gated attachment raw-bytes endpoint.
 *
 * Endpoint:
 *   GET /api/attachments/:id/raw
 *
 * Auth model (hybrid gate):
 *   1. Authenticated caller (session cookie OR `Authorization: Bearer <api-key>`):
 *      200 if the attachment's document owner == caller, 403 otherwise.
 *   2. Anonymous + `x-share-token: <token>`:
 *      200 if the share link is alive (not expired) and either targets
 *      the attachment's document directly, or has a folderId that is
 *      an ancestor of the document's folder.
 *      401 if the token is missing/expired/doesn't cover this doc.
 *   3. Anonymous without a token: 401.
 *
 * 404 cases (no such attachment) are independent of auth — the route
 * looks the row up first so missing rows don't leak existence via
 * timing. The mock's harness reads `ownerId` off the attachments row
 * directly (it does not process innerJoin), which mirrors the way
 * routes.attachments-delete.test.ts seeds the same field.
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

// Bypass the harness's `request()` for assertions that need to read
// the raw response bytes — `request()` calls `res.text()` to populate
// the parsed body, which consumes the stream so a follow-up
// `arrayBuffer()` throws ERR_BODY_ALREADY_USED. Binary responses go
// through this helper instead.
async function rawGet(
  app: any,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, { headers }),
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    bytes,
  };
}

let app: any;

const DOC_ID = "00000000-0000-4000-8000-00000000aa01";
const OTHER_DOC_ID = "00000000-0000-4000-8000-00000000aa02";
const FOLDER_ID = "00000000-0000-4000-8000-00000000aa10";
const SUBFOLDER_ID = "00000000-0000-4000-8000-00000000aa11";
const DOC_IN_SUBFOLDER = "00000000-0000-4000-8000-00000000aa12";
const ATTACHMENT_ID = "00000000-0000-4000-8000-00000000aa20";
const OTHER_ATTACHMENT_ID = "00000000-0000-4000-8000-00000000aa21";
const STORAGE_KEY = `${OWNER_ID}/${DOC_ID}/raw-test.png`;

function seedAttachment(
  opts: {
    id?: string;
    ownerId?: string;
    documentId?: string;
    storageKey?: string;
    mimeType?: string;
    folderId?: string | null;
  } = {},
) {
  const id = opts.id ?? ATTACHMENT_ID;
  getState().documents.set(opts.documentId ?? DOC_ID, {
    id: opts.documentId ?? DOC_ID,
    ownerId: opts.ownerId ?? OWNER_ID,
    title: "Owner doc",
    folderId: opts.folderId === undefined ? null : opts.folderId,
    createdAt: new Date(),
    updatedAt: new Date(),
    contentJson: null,
    content: "",
    categoryId: null,
  });
  getState().attachments.set(id, {
    id,
    documentId: opts.documentId ?? DOC_ID,
    filename: "raw-test.png",
    mimeType: opts.mimeType ?? "image/png",
    size: 4,
    storageKey: opts.storageKey ?? STORAGE_KEY,
    // Mirror the production JOIN result so the mock's
    // applyFieldSelection can read `ownerId` directly off the
    // attachments row.
    ownerId: opts.ownerId ?? OWNER_ID,
  });
  return id;
}

function seedShareLink(opts: {
  id: string;
  token: string;
  documentId?: string | null;
  folderId?: string | null;
  expiresAt?: Date | null;
}) {
  getState().shareLinks.set(opts.id, {
    id: opts.id,
    token: opts.token,
    documentId: opts.documentId ?? null,
    folderId: opts.folderId ?? null,
    passwordHash: null,
    expiresAt: opts.expiresAt === undefined ? null : opts.expiresAt,
    createdBy: OWNER_ID,
    createdAt: new Date(),
  });
}

beforeAll(async () => {
  const built = await setupHarness();
  app = built.app;
});

beforeEach(() => {
  resetState();
  getStorageMockState().getObjectShouldThrow = false;
  getStorageMockState().objectBytes.set(
    STORAGE_KEY,
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
});

afterEach(() => {
  resetState();
  getStorageMockState().getObjectShouldThrow = false;
  getStorageMockState().objectBytes.clear();
});

describe("GET /api/attachments/:id/raw — auth gate", () => {
  it("returns 401 for an anonymous request with no share token", async () => {
    seedAttachment();
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: noAuthHeaders(),
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("returns 401 for an anonymous request with an unknown share token", async () => {
    seedAttachment();
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: { ...noAuthHeaders(), "x-share-token": "no-such-token" },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("returns 401 for an anonymous request against an unknown attachment id (no existence leak)", async () => {
    // The auth gate runs BEFORE the row lookup so an anonymous
    // probe can't distinguish "id doesn't exist" from "exists
    // but you're blocked" — both must collapse to 401.
    const res = await request(
      app,
      "/api/attachments/00000000-0000-4000-8000-000000000000/raw",
      { headers: noAuthHeaders() },
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("returns 200 with bytes for the owning user", async () => {
    seedAttachment();
    const res = await rawGet(
      app,
      `/api/attachments/${ATTACHMENT_ID}/raw`,
      ownerHeaders(),
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("image/png");
    expect(Array.from(res.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("returns 403 for a different authenticated user", async () => {
    seedAttachment({ ownerId: OTHER_USER_ID, documentId: OTHER_DOC_ID });
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("returns 404 when the attachment does not exist", async () => {
    // No seed. The auth gate must run AFTER the existence lookup so
    // missing rows don't leak via timing.
    const res = await request(
      app,
      "/api/attachments/00000000-0000-4000-8000-000000000000/raw",
      {
        headers: ownerHeaders(),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/attachments/:id/raw — share-token path", () => {
  it("returns 200 when the share token targets this document directly", async () => {
    seedAttachment();
    seedShareLink({
      id: "link-direct",
      token: "share-token-direct",
      documentId: DOC_ID,
    });
    const res = await rawGet(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      ...noAuthHeaders(),
      "x-share-token": "share-token-direct",
    });
    expect(res.status).toBe(200);
    expect(res.bytes.length).toBeGreaterThan(0);
  });

  it("returns 200 when the share token covers a parent folder of the document", async () => {
    // Folder chain: FOLDER_ID (shared) → SUBFOLDER_ID → DOC_IN_SUBFOLDER
    // The document is NOT a direct child of the shared folder, so
    // this exercises the recursive ancestor walk in
    // share-access.ts.
    getState().folders.set(FOLDER_ID, {
      id: FOLDER_ID,
      ownerId: OWNER_ID,
      name: "Shared folder",
      parentId: null,
      categoryId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    getState().folders.set(SUBFOLDER_ID, {
      id: SUBFOLDER_ID,
      ownerId: OWNER_ID,
      name: "Subfolder",
      parentId: FOLDER_ID,
      categoryId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    seedAttachment({
      id: OTHER_ATTACHMENT_ID,
      documentId: DOC_IN_SUBFOLDER,
      storageKey: `${OWNER_ID}/${DOC_IN_SUBFOLDER}/nested.png`,
      folderId: SUBFOLDER_ID,
    });
    getStorageMockState().objectBytes.set(
      `${OWNER_ID}/${DOC_IN_SUBFOLDER}/nested.png`,
      Buffer.from([0x01, 0x02]),
    );
    seedShareLink({
      id: "link-folder",
      token: "share-token-folder",
      folderId: FOLDER_ID,
    });

    const res = await rawGet(
      app,
      `/api/attachments/${OTHER_ATTACHMENT_ID}/raw`,
      { ...noAuthHeaders(), "x-share-token": "share-token-folder" },
    );
    expect(res.status).toBe(200);
    expect(Array.from(res.bytes)).toEqual([0x01, 0x02]);
  });

  it("returns 401 when the share token does not cover this document", async () => {
    // Attachment belongs to OWNER's DOC_ID; share token targets a
    // different document entirely.
    seedAttachment();
    seedShareLink({
      id: "link-other",
      token: "share-token-other",
      documentId: OTHER_DOC_ID,
    });
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: { ...noAuthHeaders(), "x-share-token": "share-token-other" },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("returns 401 when the share token targets an unrelated folder", async () => {
    const UNRELATED_FOLDER = "00000000-0000-4000-8000-00000000aa99";
    getState().folders.set(UNRELATED_FOLDER, {
      id: UNRELATED_FOLDER,
      ownerId: OWNER_ID,
      name: "Unrelated",
      parentId: null,
      categoryId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    seedAttachment();
    seedShareLink({
      id: "link-unrelated",
      token: "share-token-unrelated",
      folderId: UNRELATED_FOLDER,
    });
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: { ...noAuthHeaders(), "x-share-token": "share-token-unrelated" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the share token is expired", async () => {
    seedAttachment();
    seedShareLink({
      id: "link-expired",
      token: "share-token-expired",
      documentId: DOC_ID,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: { ...noAuthHeaders(), "x-share-token": "share-token-expired" },
    });
    expect(res.status).toBe(401);
  });

  it("does not leak which failure (missing vs expired vs no-access) fired", async () => {
    // Three independent calls — unknown token, expired token,
    // unrelated token — must all collapse to the same body so an
    // attacker cannot enumerate live share tokens by comparing
    // 401 bodies.
    seedAttachment();
    seedShareLink({
      id: "link-expired-2",
      token: "share-token-expired-2",
      documentId: OTHER_DOC_ID,
      expiresAt: new Date(Date.now() - 60_000),
    });
    seedShareLink({
      id: "link-other-2",
      token: "share-token-other-2",
      documentId: OTHER_DOC_ID,
    });

    for (const token of [
      "never-seen",
      "share-token-expired-2",
      "share-token-other-2",
    ]) {
      const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
        headers: { ...noAuthHeaders(), "x-share-token": token },
      });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Authentication required" });
    }
  });
});

describe("GET /api/attachments/:id/raw — streaming", () => {
  it("returns a private-cache Response so caches don't share auth-gated bytes across users", async () => {
    seedAttachment();
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(200);
    const cache = res.headers.get("cache-control") ?? "";
    // Must NOT be `public, ...` — a shared cache would serve the
    // auth-gated response to anyone hitting the same URL.
    expect(cache.startsWith("public")).toBe(false);
  });

  it("propagates storage getObject failures as 500", async () => {
    seedAttachment();
    getStorageMockState().getObjectShouldThrow = true;
    const res = await request(app, `/api/attachments/${ATTACHMENT_ID}/raw`, {
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(500);
  });
});
