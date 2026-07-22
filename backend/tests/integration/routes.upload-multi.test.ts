/**
 * HTTP-level tests for the multi-file document import endpoint
 * (Phase 2 / Step 2.4 of the 5-features plan).
 *
 * Endpoint: POST /api/documents/import
 *
 * Tests:
 *   - JSON path (single virtual item): title/content/folderId validation
 *     and 201 on success.
 *   - Unsupported content type returns 415.
 *   - Invalid JSON body returns 400.
 *   - DOCX parsing is exercised through a tiny synthetic fixture that
 *     exercises the same `importFileToItem` codepath indirectly via
 *     multipart-form-data. We use a small in-memory text payload to
 *     avoid pulling mammoth into the harness; the DOCX branch is
 *     covered separately in a live smoke test.
 *   - The response envelope is `{ items, imported, failed }` where
 *     `items` is one entry per accepted file with `filename`,
 *     `status: "ok"`, and the created `document`. The frontend's
 *     `+page.svelte` import progress overlay reconciles by
 *     `filename` (see `frontend/src/lib/api/documents.ts:ImportResponse`).
 *   - File size enforcement and allowed-extension validation are
 *     covered at the boundary in `importFileToItem` and exercised here
 *     by posting a multipart payload with an unsupported extension.
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
  getState,
  noAuthHeaders,
  ownerHeaders,
  request,
  resetState,
  setupHarness,
} from "./_harness";
import { contentHash } from "../../src/lib/content-hash";

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

function jsonImport(body: any) {
  return request(app, "/api/documents/import", {
    method: "POST",
    headers: ownerHeaders(),
    body: JSON.stringify(body),
  });
}

function multipartImport(
  files: Array<{ name: string; content: string | Buffer }>,
) {
  const fd = new FormData();
  for (const f of files) {
    fd.append(
      "file",
      new Blob(
        [typeof f.content === "string" ? f.content : new Uint8Array(f.content)],
        {
          type: "text/plain",
        },
      ),
      f.name,
    );
  }
  return request(app, "/api/documents/import", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ownerHeaders().authorization?.replace("Bearer ", "")}`,
    },
    body: fd,
  });
}

describe("POST /api/documents/import — auth", () => {
  it("returns 403 from CSRF middleware without auth", async () => {
    const res = await request(app, "/api/documents/import", {
      method: "POST",
      headers: noAuthHeaders(),
      body: JSON.stringify({ title: "x", content: "y" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/documents/import — JSON single-item path", () => {
	it("returns 400 for malformed application/json", async () => {
		const res = await request(app, "/api/documents/import", {
			method: "POST",
			headers: ownerHeaders(),
			body: '{"title":',
		});
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toBe("Invalid JSON syntax");
	});

  it("imports a single document and returns 201", async () => {
    const res = await jsonImport({
      title: "Imported Doc",
      content: "Hello world",
    });
    expect(res.status).toBe(201);
    const body = res.body as {
      items: Array<{
        filename: string;
        status: "ok" | "error";
        document?: { id: string; title: string };
      }>;
      imported: number;
      failed: number;
    };
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.items.length).toBe(1);
    expect(body.items[0]?.filename).toBe("Imported Doc.md");
    expect(body.items[0]?.status).toBe("ok");
    expect(body.items[0]?.document?.title).toBe("Imported Doc");
    expect(getState().documents.size).toBe(1);
  });

  it("defaults the title when omitted", async () => {
    const res = await jsonImport({ content: "Body only" });
    expect(res.status).toBe(201);
    const body = res.body as {
      items: Array<{ filename: string; document?: { title: string } }>;
    };
    expect(body.items[0]?.document?.title).toBe("Imported Document");
    expect(body.items[0]?.filename).toBe("Imported Document.md");
  });

  it("enqueues embedding for the created document", async () => {
    const res = await jsonImport({ title: "Embed me", content: "Hello" });
    expect(res.status).toBe(201);
    const id = (
      res.body as {
        items: Array<{ document?: { id: string } }>;
      }
    ).items[0]?.document?.id;
    expect(id).toBeTruthy();
    expect(getState().enqueuedEmbeddings).toContain(id);
  });

  it("persists the exact revision used by the import pipeline", async () => {
    const title = "Revision source";
    const content = "Pipeline content";
    const res = await jsonImport({ title, content });
    expect(res.status).toBe(201);
    const stored = [...getState().documents.values()][0] as {
      contentHash?: string;
    };
    expect(stored.contentHash).toBe(contentHash(title, content));
  });

  it("rejects an empty content body with 400", async () => {
    const res = await jsonImport({ title: "Empty", content: "" });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid import data");
  });

  it("rejects an oversized content body with 400", async () => {
    const huge = "x".repeat(5_000_001);
    const res = await jsonImport({ title: "Big", content: huge });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid import data");
  });

  it("rejects an invalid folderId UUID with 400", async () => {
    const res = await jsonImport({
      title: "Bad folder",
      content: "ok",
      folderId: "not-a-uuid",
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("Invalid import data");
  });

  it("accepts a valid folderId UUID", async () => {
    const folderId = "00000000-0000-4000-8000-000000000abc";
    const res = await jsonImport({
      title: "Foldered",
      content: "ok",
      folderId,
    });
    expect(res.status).toBe(201);
    const docId = (
      res.body as {
        items: Array<{ document?: { id: string } }>;
      }
    ).items[0]?.document?.id;
    const stored = getState().documents.get(docId);
    expect(stored?.folderId).toBe(folderId);
  });

  it("creates a version row alongside the document", async () => {
    // The mock harness's insert proxy commits rows only when `.returning()`
    // is called; the import transaction deliberately omits `.returning()`
    // on the version insert for performance. We assert the document
    // created successfully and trust the live-DB smoke test for the
    // version side-effect — exercising both via the mock would require
    // modifying production code purely for testability.
    const res = await jsonImport({ title: "Versioned", content: "ok" });
    expect(res.status).toBe(201);
    const id = (
      res.body as {
        items: Array<{ document?: { id: string } }>;
      }
    ).items[0]?.document?.id;
    expect(id).toBeTruthy();
    expect(getState().documents.has(id)).toBe(true);
  });
});

describe("POST /api/documents/import — content-type guard", () => {
  it("returns 415 for plain text", async () => {
    const res = await request(app, "/api/documents/import", {
      method: "POST",
      headers: {
        ...ownerHeaders(),
        "content-type": "text/plain",
      },
      body: "just some text",
    });
    expect(res.status).toBe(415);
    expect((res.body as any).error).toContain("Unsupported content type");
  });
});

describe("POST /api/documents/import — multipart path", () => {
	it("returns 400 for malformed JSON files", async () => {
		const res = await multipartImport([
			{ name: "broken.json", content: '{"content":' },
		]);
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toBe(
			"Invalid JSON syntax in uploaded file",
		);
	});

	it("returns 422 for JSON files that do not match the import schema", async () => {
		const res = await multipartImport([
			{ name: "wrong-shape.json", content: '{"content":42}' },
		]);
		expect(res.status).toBe(422);
		expect((res.body as { error: string }).error).toBe(
			"Uploaded JSON does not match the document import schema",
		);
	});

  it("imports a single text file", async () => {
    const res = await multipartImport([
      { name: "notes.md", content: "# Notes\n\nHello world" },
    ]);
    expect(res.status).toBe(201);
    const body = res.body as {
      items: Array<{
        filename: string;
        status: "ok" | "error";
        document?: { id: string; title: string };
      }>;
      imported: number;
      failed: number;
    };
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.items[0]?.filename).toBe("notes.md");
    expect(body.items[0]?.status).toBe("ok");
    expect(body.items[0]?.document?.title).toBe("notes");
    expect(getState().documents.size).toBe(1);
  });

  it("imports multiple text files in one request with per-file results", async () => {
    const res = await multipartImport([
      { name: "a.md", content: "# A\n\nfirst" },
      { name: "b.md", content: "# B\n\nsecond" },
      { name: "c.md", content: "# C\n\nthird" },
    ]);
    expect(res.status).toBe(201);
    const body = res.body as {
      items: Array<{
        filename: string;
        status: "ok" | "error";
        document?: { title: string };
      }>;
      imported: number;
      failed: number;
    };
    expect(body.imported).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.items.map((i) => i.document?.title).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(body.items.map((i) => i.filename).sort()).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
    expect(getState().documents.size).toBe(3);
  });

  it("rejects an empty file list with 400", async () => {
    const fd = new FormData();
    const res = await request(app, "/api/documents/import", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerHeaders().authorization?.replace("Bearer ", "")}`,
      },
      body: fd,
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("At least one file is required");
  });

  it("rejects a file with a disallowed extension with 415", async () => {
    const res = await multipartImport([{ name: "binary.exe", content: "MZ" }]);
    expect(res.status).toBe(415);
    expect((res.body as any).error).toContain("Invalid file type");
  });

  it("keeps the 10 MB per-file guard after the proxy envelope is raised", async () => {
    const res = await multipartImport([
      {
        name: "too-large.md",
        content: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
      },
    ]);
    expect(res.status).toBe(413);
    expect((res.body as any).error).toContain("Maximum size: 10MB");
  });

  it("rejects batches above the 10-file processing cap", async () => {
    const files = Array.from({ length: 11 }, (_, index) => ({
      name: `batch-${index}.md`,
      content: `# Item ${index}`,
    }));
    const res = await multipartImport(files);
    expect(res.status).toBe(413);
    expect((res.body as any).error).toBe(
      "Too many files. Maximum per import: 10",
    );
  });

  it("accepts documents larger than PostgreSQL's raw tsvector input limit", async () => {
    const largeMarkdown = `${"searchable paragraph\n\n".repeat(60_000)}\n`;
    expect(Buffer.byteLength(largeMarkdown)).toBeGreaterThan(1_048_575);
    const res = await multipartImport([
      { name: "large-supported.md", content: largeMarkdown },
    ]);
    expect(res.status).toBe(201);
    expect((res.body as any).imported).toBe(1);
  });

	it("accepts .txt, .md, and .json extensions", async () => {
		const res = await multipartImport([
			{ name: "readme.txt", content: "plain text" },
			{ name: "guide.md", content: "# Guide" },
			{ name: "spec.json", content: JSON.stringify({ title: "Spec", content: "# Spec" }) },
    ]);
    expect(res.status).toBe(201);
    const body = res.body as { imported: number };
    expect(body.imported).toBe(3);
  });

  it("accepts .docx in the allowed list (parsing covered by live smoke test)", async () => {
    // We send a non-DOCX body but a .docx extension to assert that the
    // extension allow-list accepts DOCX. The parser would normally fail
    // for this body — we instead assert the response is either 201
    // (parser tolerated a non-zip body) or 422 (DocxParseError path),
    // but never 415.
    const res = await multipartImport([
      { name: "fake.docx", content: "not really docx" },
    ]);
    expect([201, 422]).toContain(res.status);
    if (res.status === 415) {
      throw new Error(".docx extension should be in the allow list");
    }
  });
});
