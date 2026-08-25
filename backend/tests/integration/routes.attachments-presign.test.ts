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
 *   - presign happy path: returns durable { url, key, uploadToken, ... } admission.
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
	getState,
	getStorageMockState,
	noAuthHeaders,
	OTHER_USER_ID,
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
	opts: { filename?: string; contentType?: string; size?: number } = {},
) {
	return {
		filename: opts.filename ?? "photo.png",
		contentType: opts.contentType ?? "image/png",
		size: opts.size ?? 1024,
	};
}

function confirmBody(opts: {
	documentId: string;
	uploadToken: string;
	key?: string;
	filename?: string;
	contentType?: string;
	size?: number;
}) {
	return {
		key: opts.key ?? `${OWNER_ID}/${opts.documentId}/abc.png`,
		uploadToken: opts.uploadToken,
		filename: opts.filename ?? "photo.png",
		contentType: opts.contentType ?? "image/png",
		size: opts.size ?? 1024,
	};
}

async function admitUpload(
	documentId: string,
	body: ReturnType<typeof presignBody> = presignBody(),
): Promise<{ key: string; uploadToken: string }> {
	const response = await request(
		app,
		`/api/documents/${documentId}/attachments/presign`,
		{
			method: "POST",
			headers: ownerHeaders(),
			body: JSON.stringify(body),
		},
	);
	expect(response.status).toBe(200);
	const admission = response.body as { key: string; uploadToken: string };
	expect(admission.uploadToken).toBeString();
	return admission;
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
			uploadToken: string;
			maxSize: number;
			expiresIn: number;
		};
		expect(typeof body.url).toBe("string");
		expect(new URL(body.url).origin).toBe("http://storage.local");
		expect(body.url).not.toContain("seaweedfs");
		expect(new URL(body.url).username).toBe("");
		expect(new URL(body.url).password).toBe("");
		expect(body.url).toContain(docId);
		expect(body.key.startsWith(`${OWNER_ID}/${docId}/`)).toBe(true);
		expect(body.uploadToken).toBeString();
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
	it("returns a masked 404 for a valid admission with invalid auth", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
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
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);
		expect(res.status).toBe(404);
	});

	it("returns 403 without auth (CSRF blocks first)", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
		const res = await request(
			app,
			`/api/documents/${docId}/attachments/confirm`,
			{
				method: "POST",
				headers: noAuthHeaders(),
				body: JSON.stringify(
					confirmBody({
						documentId: docId,
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);
		expect(res.status).toBe(403);
	});

	it("returns 409 when storage has no object", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
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
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);
		expect(res.status).toBe(409);
		// Reset for any siblings in this `it`.
		getStorageMockState().statObjectShouldThrow = false;
	});

	it("does not confirm an admission after its durable expiry", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
		const pending = [...getState().pendingAttachmentUploads.values()].find(
			(row) => row.storageKey === admission.key,
		);
		expect(pending).toBeDefined();
		pending.expiresAt = new Date(Date.now() - 1_000);
		getStorageMockState().storedSizes.set(admission.key, 1024);

		const response = await request(
			app,
			`/api/documents/${docId}/attachments/confirm`,
			{
				method: "POST",
				headers: ownerHeaders(),
				body: JSON.stringify(
					confirmBody({
						documentId: docId,
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);

		expect(response.status).toBe(409);
		expect(getState().attachments.size).toBe(0);
		expect(getState().pendingAttachmentUploads.size).toBe(1);
	});

	it("returns 201 and inserts a row on happy path", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId, presignBody({ size: 4096 }));
		const key = admission.key;
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
						uploadToken: admission.uploadToken,
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

	it("deletes an object whose actual stored size exceeds the attachment cap", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
		const key = admission.key;
		const storage = getStorageMockState();
		storage.storedSizes.set(key, 26 * 1024 * 1024);
		const removeCallsBefore = storage.removeObjectCalls;

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
						uploadToken: admission.uploadToken,
						size: 1024,
					}),
				),
			},
		);

		expect(res.status).toBe(413);
		expect(res.body).toEqual({ error: "Uploaded file exceeds the 25MB limit" });
		expect(storage.removeObjectCalls).toBe(removeCallsBefore + 1);
		expect(storage.removedKeys.at(-1)).toBe(key);
		expect(getState().attachments.size).toBe(0);
	});

	it("retains a durable cleanup intent when rejected-confirm object deletion fails", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
		const storage = getStorageMockState();
		storage.storedSizes.set(admission.key, 26 * 1024 * 1024);
		storage.removeObjectShouldThrow = true;

		const response = await request(
			app,
			`/api/documents/${docId}/attachments/confirm`,
			{
				method: "POST",
				headers: ownerHeaders(),
				body: JSON.stringify(
					confirmBody({
						documentId: docId,
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);

		expect(response.status).toBe(413);
		expect(getState().pendingAttachmentUploads.size).toBe(0);
		expect(getState().attachmentStorageCleanupOutbox.size).toBe(1);
		expect(getState().attachments.size).toBe(0);
	});

	it("deletes an object when storage omits its content length", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
		const key = admission.key;
		const storage = getStorageMockState();
		storage.storedSizes.set(key, undefined);
		const removeCallsBefore = storage.removeObjectCalls;

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
						uploadToken: admission.uploadToken,
						size: 1024,
					}),
				),
			},
		);

		expect(res.status).toBe(409);
		expect(res.body).toEqual({ error: "Upload size could not be verified" });
		expect(storage.removeObjectCalls).toBe(removeCallsBefore + 1);
		expect(storage.removedKeys.at(-1)).toBe(key);
		expect(getState().attachments.size).toBe(0);
	});

	it("deletes objects with non-finite or non-positive content lengths", async () => {
		const docId = seedOwnedDocument();
		const storage = getStorageMockState();

		for (const [label, storedSize] of [
			["nan", Number.NaN],
			["infinity", Number.POSITIVE_INFINITY],
			["zero", 0],
			["negative", -1],
		] as const) {
			const admission = await admitUpload(
				docId,
				presignBody({ filename: `${label}.png` }),
			);
			const key = admission.key;
			storage.storedSizes.set(key, storedSize);

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
							uploadToken: admission.uploadToken,
							filename: `${label}.png`,
							size: 1024,
						}),
					),
				},
			);

			expect({ label, status: res.status, body: res.body }).toEqual({
				label,
				status: 409,
				body: { error: "Upload size could not be verified" },
			});
			expect(res.body).toEqual({ error: "Upload size could not be verified" });
			expect(storage.removedKeys.at(-1)).toBe(key);
		}
		expect(getState().attachments.size).toBe(0);
	});

	it("returns 400 when the key prefix doesn't match the user", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
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
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when the key prefix doesn't match the document", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
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
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);
		expect(res.status).toBe(400);
	});

	it("returns 415 for a non-image contentType", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
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
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);
		expect(res.status).toBe(415);
	});

	it("returns 400 when confirm size differs from the admitted size", async () => {
		const docId = seedOwnedDocument();
		const admission = await admitUpload(docId);
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
						key: admission.key,
						uploadToken: admission.uploadToken,
					}),
				),
			},
		);
		expect(res.status).toBe(400);
	});
});

describe("POST /api/documents/:id/attachments legacy upload", () => {
	it("deletes the uploaded object when the attachment insert throws", async () => {
		const docId = seedOwnedDocument();
		const storage = getStorageMockState();
		const removeCallsBefore = storage.removeObjectCalls;
		getState().insertFailures.add("attachments");
		const form = new FormData();
		form.set(
			"file",
			new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "upload.png", {
				type: "image/png",
			}),
		);

		const res = await request(app, `/api/documents/${docId}/attachments`, {
			method: "POST",
			headers: { authorization: ownerHeaders().authorization },
			body: form,
		});

		expect(res.status).toBe(500);
		expect(res.body).toEqual({ error: "Failed to upload attachment" });
		expect(storage.putObjectCalls).toBeGreaterThan(0);
		expect(storage.removeObjectCalls).toBe(removeCallsBefore + 1);
		expect(storage.removedKeys.at(-1)).toStartWith(`${OWNER_ID}/${docId}/`);
		expect(getState().attachments.size).toBe(0);
	});
});
