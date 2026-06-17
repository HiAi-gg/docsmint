/**
 * HTTP-level tests for version routes.
 * Tests:
 *   GET  /api/documents/:id/versions
 *   GET  /api/documents/:id/versions/:vid
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
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

const docId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherDocId = "99999999-9999-4999-8999-999999999999";

function seedDocument(id: string = docId, owner: string = OWNER_ID) {
	getState().documents.set(id, {
		id,
		ownerId: owner,
		folderId: null,
		title: "Doc",
		content: "",
		createdAt: new Date(),
		updatedAt: new Date(),
	});
}

function seedVersions() {
	getState().versions.push(
		{
			id: "v-old",
			documentId: docId,
			content: "first draft",
			contentTipex: null,
			createdBy: OWNER_ID,
			createdAt: new Date("2024-01-01T00:00:00Z"),
		},
		{
			id: "v-mid",
			documentId: docId,
			content: "second draft",
			contentTipex: null,
			createdBy: OWNER_ID,
			createdAt: new Date("2024-02-01T00:00:00Z"),
		},
		{
			id: "v-new",
			documentId: docId,
			content: "final draft",
			contentTipex: null,
			createdBy: OWNER_ID,
			createdAt: new Date("2024-03-01T00:00:00Z"),
		},
	);
}

describe("GET /api/documents/:id/versions", () => {
	it("returns 401 without auth", async () => {
		const res = await request(app, `/api/documents/${docId}/versions`, {
			method: "GET",
			headers: noAuthHeaders(),
		});
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 404 when the document does not exist", async () => {
		const res = await authedGet(
			`/api/documents/00000000-0000-4000-8000-000000000099/versions`,
		);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Document not found");
	});

	it("returns 404 for documents owned by other users", async () => {
		seedDocument(otherDocId, "00000000-0000-4000-8000-000000000999");
		const res = await authedGet(`/api/documents/${otherDocId}/versions`);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Document not found");
	});

	it("returns an empty array when the document has no versions", async () => {
		seedDocument();
		const res = await authedGet(`/api/documents/${docId}/versions`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("returns all versions for the document ordered newest-first", async () => {
		seedDocument();
		seedVersions();

		const res = await authedGet(`/api/documents/${docId}/versions`);
		expect(res.status).toBe(200);
		const items = res.body as Array<{ id: string; createdAt: string }>;
		expect(items.length).toBe(3);
		expect(items.map((v) => v.id)).toEqual(["v-new", "v-mid", "v-old"]);
	});

	it("only returns versions belonging to the requested document", async () => {
		seedDocument();
		seedDocument("other-doc");
		getState().versions.push(
			{
				id: "v-x",
				documentId: "other-doc",
				content: "unrelated",
				contentTipex: null,
				createdBy: OWNER_ID,
				createdAt: new Date("2024-04-01T00:00:00Z"),
			},
			{
				id: "v-y",
				documentId: docId,
				content: "mine",
				contentTipex: null,
				createdBy: OWNER_ID,
				createdAt: new Date("2024-04-02T00:00:00Z"),
			},
		);

		const res = await authedGet(`/api/documents/${docId}/versions`);
		expect(res.status).toBe(200);
		const items = res.body as Array<{ id: string }>;
		const ids = items.map((v) => v.id);
		expect(ids).toContain("v-y");
		expect(ids).not.toContain("v-x");
	});
});

describe("GET /api/documents/:id/versions/:vid", () => {
	it("returns 401 without auth", async () => {
		const res = await request(app, `/api/documents/${docId}/versions/v-new`, {
			method: "GET",
			headers: noAuthHeaders(),
		});
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 404 when the document does not exist", async () => {
		const res = await authedGet(
			`/api/documents/00000000-0000-4000-8000-000000000099/versions/v-new`,
		);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Document not found");
	});

	it("returns 404 when the version does not exist", async () => {
		seedDocument();
		const res = await authedGet(`/api/documents/${docId}/versions/v-missing`);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Version not found");
	});

	it("returns the requested version", async () => {
		seedDocument();
		seedVersions();

		const res = await authedGet(`/api/documents/${docId}/versions/v-mid`);
		expect(res.status).toBe(200);
		const body = res.body as {
			id: string;
			documentId: string;
			content: string;
		};
		expect(body.id).toBe("v-mid");
		expect(body.documentId).toBe(docId);
		expect(body.content).toBe("second draft");
	});

	it("does not return a version that belongs to a different document", async () => {
		seedDocument();
		seedDocument("other-doc");
		getState().versions.push({
			id: "v-other-doc",
			documentId: "other-doc",
			content: "no-peeking",
			contentTipex: null,
			createdBy: OWNER_ID,
			createdAt: new Date("2024-05-01T00:00:00Z"),
		});

		const res = await authedGet(
			`/api/documents/${docId}/versions/v-other-doc`,
		);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Version not found");
	});

	it("does not return versions for documents owned by other users", async () => {
		seedDocument(otherDocId, "00000000-0000-4000-8000-000000000999");
		getState().versions.push({
			id: "v-foreign",
			documentId: otherDocId,
			content: "secret",
			contentTipex: null,
			createdBy: "00000000-0000-4000-8000-000000000999",
			createdAt: new Date("2024-06-01T00:00:00Z"),
		});

		const res = await authedGet(
			`/api/documents/${otherDocId}/versions/v-foreign`,
		);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Document not found");
	});
});