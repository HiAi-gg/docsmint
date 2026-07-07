/**
 * HTTP-level tests for the presigned-URL attachment upload flow.
 *
 * Endpoints:
 *   POST /api/documents/:id/attachments/presign
 *   POST /api/documents/:id/attachments/confirm
 *
 * Tests:
 *   - presign auth: 401 without auth, 200 with auth.
 *   - presign validation: filename, contentType, size.
 *   - presign over-cap: 413 when size > ATTACHMENT_MAX_SIZE_MB.
 *   - presign happy path: returns { url, key, maxSize, expiresIn }.
 *   - confirm: 409 when storage has no object, 201 when statObject returns.
 *   - confirm rejection: key that doesn't match the user's prefix is rejected.
 *   - confirm inserts a row whose `url` points at /api/attachments/:id/raw.
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

beforeAll(async () => {
  const built = await setupHarness();
  app = built.app;
});

beforeEach(() => {
  resetState();
  // Reset storage mock to the happy path. Individual tests that simulate
  // failures flip the flag and reset it themselves so they never leak
  // into siblings.
  getStorageMockState().statObjectShouldThrow = false;
});

afterEach(() => {
  resetState();
  getStorageMockState().statObjectShouldThrow = false;
});

function seedOwnedDocument(): string {
  const docId = "00000000-0000-4000-8000-000000000099";
  getState().documents.set(docId, {
    id: docId,
    ownerId: OWNER_ID,
    title: "Test doc",
    folderId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    contentJson: null,
    content: "",
    categoryId: null,
  });
  return docId;
}

function presignBody(
  opts: {
    filename?: string;
    contentType?: string;
    size?: number;
  } = {},
) {
  return {
    filename: opts.filename ?? "photo.png",
    contentType: opts.contentType ?? "image/png",
    size: opts.size ?? 1024,
  };
}

function confirmBody(opts: {
  documentId: string;
  key?: string;
  filename?: string;
  contentType?: string;
  size?: number;
}) {
  return {
    key: opts.key ?? `${OWNER_ID}/${opts.documentId}/abc.png`,
    filename: opts.filename ?? "photo.png",
    contentType: opts.contentType ?? "image/png",
    size: opts.size ?? 1024,
  };
}

describe("POST /api/documents/:id/attachments/presign", () => {
  it("returns 401 with an invalid bearer token (CSRF passes)", async () => {
    // CSRF middleware short-circuits on any Bearer-prefixed
    // Authorization header (line 58 of csrf.ts), so we can use an
    // INVALID Bearer token to drive the request past CSRF and into
    // the auth check. ownerHeaders() (a VALID bearer) bypasses CSRF
    // the same way and is used in the happy-path tests; here we want
    // to verify the auth-helpers fallback path.
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer not-a-valid-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(presignBody()),
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 without auth (CSRF blocks first)", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: noAuthHeaders(),
        body: JSON.stringify(presignBody()),
      },
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown document", async () => {
    const res = await request(
      app,
      "/api/documents/does-not-exist/attachments/presign",
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(presignBody()),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns the presigned URL, key, maxSize, and expiresIn", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(presignBody({ size: 5_000_000 })),
      },
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      url: string;
      key: string;
      maxSize: number;
      expiresIn: number;
    };
    expect(typeof body.url).toBe("string");
    expect(body.url).toContain(docId);
    expect(body.key.startsWith(`${OWNER_ID}/${docId}/`)).toBe(true);
    expect(body.maxSize).toBe(25 * 1024 * 1024);
    expect(body.expiresIn).toBe(900);
  });

  it("returns 413 for sizes above the cap", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(presignBody({ size: 26 * 1024 * 1024 })),
      },
    );
    expect(res.status).toBe(413);
  });

  it("returns 415 for non-image content types", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(presignBody({ contentType: "application/pdf" })),
      },
    );
    expect(res.status).toBe(415);
  });

  it("returns 400 for missing filename", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ contentType: "image/png", size: 1024 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for zero size", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(presignBody({ size: 0 })),
      },
    );
    expect(res.status).toBe(400);
  });

  it("forces the key to start with the requesting user's id", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/presign`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(presignBody()),
      },
    );
    expect(res.status).toBe(200);
    const body = res.body as { key: string };
    expect(body.key.startsWith(`${OWNER_ID}/`)).toBe(true);
  });
});

describe("POST /api/documents/:id/attachments/confirm", () => {
  it("returns 401 with an invalid bearer token", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/confirm`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer not-a-valid-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(
          confirmBody({
            documentId: docId,
            key: `${OWNER_ID}/${docId}/abc.png`,
          }),
        ),
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 without auth (CSRF blocks first)", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/confirm`,
      {
        method: "POST",
        headers: noAuthHeaders(),
        body: JSON.stringify(
          confirmBody({
            documentId: docId,
            key: `${OWNER_ID}/${docId}/abc.png`,
          }),
        ),
      },
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when storage has no object", async () => {
    const docId = seedOwnedDocument();
    getStorageMockState().statObjectShouldThrow = true;
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/confirm`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(
          confirmBody({
            documentId: docId,
            key: `${OWNER_ID}/${docId}/gone.png`,
          }),
        ),
      },
    );
    expect(res.status).toBe(409);
    // Reset for any siblings in this `it`.
    getStorageMockState().statObjectShouldThrow = false;
  });

  it("returns 201 and inserts a row on happy path", async () => {
    const docId = seedOwnedDocument();
    const key = `${OWNER_ID}/${docId}/happy.png`;
    // Pre-populate storage's stored-size map so statObject returns a
    // realistic size — in production this would have been written by
    // the PUT that landed just before this confirm call.
    getStorageMockState().storedSizes.set(key, 4096);

    const res = await request(
      app,
      `/api/documents/${docId}/attachments/confirm`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(
          confirmBody({
            documentId: docId,
            key,
            size: 4096,
          }),
        ),
      },
    );
    expect(res.status).toBe(201);
    const body = res.body as {
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      url: string;
    };
    expect(body.url.startsWith("/api/attachments/")).toBe(true);
    expect(body.url.endsWith("/raw")).toBe(true);
    expect(body.mimeType).toBe("image/png");
    expect(getState().attachments.size).toBe(1);
    const stored = Array.from(getState().attachments.values())[0] as {
      storageKey: string;
      documentId: string;
      size: number;
    };
    expect(stored.storageKey).toBe(key);
    expect(stored.documentId).toBe(docId);
    expect(stored.size).toBe(4096);
  });

  it("returns 400 when the key prefix doesn't match the user", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/confirm`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(
          confirmBody({
            documentId: docId,
            key: `${OTHER_USER_ID}/${docId}/malicious.png`,
          }),
        ),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when the key prefix doesn't match the document", async () => {
    const docId = seedOwnedDocument();
    const otherDoc = "00000000-0000-4000-8000-0000000000aa";
    getState().documents.set(otherDoc, {
      id: otherDoc,
      ownerId: OWNER_ID,
      title: "Other",
      folderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      contentJson: null,
      content: "",
      categoryId: null,
    });
    const res = await request(
      app,
      `/api/documents/${otherDoc}/attachments/confirm`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(
          confirmBody({
            documentId: otherDoc,
            key: `${OWNER_ID}/${docId}/crossdoc.png`,
          }),
        ),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 415 for a non-image contentType", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/confirm`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(
          confirmBody({
            documentId: docId,
            contentType: "text/plain",
            key: `${OWNER_ID}/${docId}/note.txt`,
          }),
        ),
      },
    );
    expect(res.status).toBe(415);
  });

  it("returns 413 for sizes above the cap", async () => {
    const docId = seedOwnedDocument();
    const res = await request(
      app,
      `/api/documents/${docId}/attachments/confirm`,
      {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify(
          confirmBody({
            documentId: docId,
            size: 26 * 1024 * 1024,
            key: `${OWNER_ID}/${docId}/big.png`,
          }),
        ),
      },
    );
    expect(res.status).toBe(413);
  });
});
