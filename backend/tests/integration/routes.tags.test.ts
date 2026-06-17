/**
 * HTTP-level tests for tag routes.
 * Tests:
 *   GET /api/tags
 *   POST /api/tags
 *   PATCH /api/tags/:id
 *   DELETE /api/tags/:id
 *   POST /api/documents/:id/tags
 *   DELETE /api/documents/:id/tags/:tagId
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

describe("GET /api/tags", () => {
	it("returns 401 without auth", async () => {
		const res = await request(app, "/api/tags", {
			method: "GET",
			headers: noAuthHeaders(),
		});
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("returns 200 with empty array when no tags exist", async () => {
		const res = await authedGet("/api/tags");
		expect(res.status).toBe(200);
		expect(res.body).toEqual([]);
	});

	it("returns tags owned by the current user with document counts", async () => {
		const state = getState();
		state.tags.set("tag-1", {
			id: "tag-1",
			ownerId: OWNER_ID,
			name: "alpha",
			color: "#ff0000",
			createdAt: new Date(),
		});
		state.tags.set("tag-2", {
			id: "tag-2",
			ownerId: OWNER_ID,
			name: "beta",
			color: null,
			createdAt: new Date(),
		});
		state.tags.set("tag-other", {
			id: "tag-other",
			ownerId: "00000000-0000-4000-8000-000000000999",
			name: "should-not-appear",
			color: null,
			createdAt: new Date(),
		});
		state.documentTags.push(
			{ documentId: "doc-1", tagId: "tag-1" },
			{ documentId: "doc-2", tagId: "tag-1" },
			{ documentId: "doc-3", tagId: "tag-2" },
		);

		const res = await authedGet("/api/tags");
		expect(res.status).toBe(200);
		const items = res.body as Array<{
			id: string;
			name: string;
			documentCount: number;
		}>;
		const tag1 = items.find((t) => t.id === "tag-1");
		const tag2 = items.find((t) => t.id === "tag-2");
		expect(tag1).toBeTruthy();
		expect(tag2).toBeTruthy();
		expect(tag1?.documentCount).toBe(2);
		expect(tag2?.documentCount).toBe(1);
		expect(items.find((t) => t.id === "tag-other")).toBeUndefined();
	});
});

describe("POST /api/tags", () => {
	it("returns 403 from CSRF middleware without auth and without CSRF token", async () => {
		const res = await request(app, "/api/tags", {
			method: "POST",
			headers: noAuthHeaders(),
			body: JSON.stringify({ name: "x" }),
		});
		expect(res.status).toBe(403);
		expect((res.body as any).error).toMatch(/CSRF/i);
	});

	it("returns 400 for invalid input (missing name)", async () => {
		const res = await authedPost("/api/tags", {});
		expect(res.status).toBe(400);
		expect((res.body as any).error).toBe("Invalid input");
	});

	it("creates a tag and returns 201", async () => {
		const res = await authedPost("/api/tags", {
			name: "important",
			color: "#00ff00",
		});
		expect(res.status).toBe(201);
		const body = res.body as {
			id: string;
			name: string;
			color: string;
			ownerId: string;
		};
		expect(body.name).toBe("important");
		expect(body.color).toBe("#00ff00");
		expect(body.ownerId).toBe(OWNER_ID);
		expect(body.id).toBeTruthy();

		const stored = (getState().tags.get(body.id) as any) ?? null;
		expect(stored).not.toBeNull();
		expect(stored.name).toBe("important");
		expect(stored.ownerId).toBe(OWNER_ID);
	});

	it("allows color to be omitted", async () => {
		const res = await authedPost("/api/tags", { name: "no-color" });
		expect(res.status).toBe(201);
		expect((res.body as any).name).toBe("no-color");
	});

	it("returns 409 when a tag with the same name already exists", async () => {
		getState().tags.set("existing", {
			id: "existing",
			ownerId: OWNER_ID,
			name: "duplicate",
			color: null,
			createdAt: new Date(),
		});

		const res = await authedPost("/api/tags", { name: "duplicate" });
		expect(res.status).toBe(409);
		expect((res.body as any).error).toMatch(/already exists/i);
	});
});

describe("PATCH /api/tags/:id", () => {
	it("returns 400 for invalid body", async () => {
		const res = await authedPatch(
			"/api/tags/00000000-0000-4000-8000-000000000099",
			{ name: "" },
		);
		expect(res.status).toBe(400);
		expect((res.body as any).error).toBe("Invalid input");
	});

	it("returns 404 when the tag does not exist", async () => {
		const res = await authedPatch(
			"/api/tags/00000000-0000-4000-8000-000000000099",
			{ name: "renamed" },
		);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Tag not found");
	});

	it("renames a tag", async () => {
		const id = "11111111-1111-4111-8111-111111111111";
		getState().tags.set(id, {
			id,
			ownerId: OWNER_ID,
			name: "old",
			color: "#000000",
			createdAt: new Date(),
		});

		const res = await authedPatch(`/api/tags/${id}`, { name: "new" });
		expect(res.status).toBe(200);
		expect((res.body as any).name).toBe("new");
		expect((getState().tags.get(id) as any).name).toBe("new");
	});

	it("updates color", async () => {
		const id = "22222222-2222-4222-8222-222222222222";
		getState().tags.set(id, {
			id,
			ownerId: OWNER_ID,
			name: "colored",
			color: "#000000",
			createdAt: new Date(),
		});

		const res = await authedPatch(`/api/tags/${id}`, { color: "#ffffff" });
		expect(res.status).toBe(200);
		expect((res.body as any).color).toBe("#ffffff");
		expect((getState().tags.get(id) as any).color).toBe("#ffffff");
	});

	it("does not update tags owned by other users", async () => {
		const id = "33333333-3333-4333-8333-333333333333";
		getState().tags.set(id, {
			id,
			ownerId: "00000000-0000-4000-8000-000000000999",
			name: "other-user",
			color: null,
			createdAt: new Date(),
		});

		const res = await authedPatch(`/api/tags/${id}`, { name: "hijack" });
		expect(res.status).toBe(404);
		expect((getState().tags.get(id) as any).name).toBe("other-user");
	});
});

describe("DELETE /api/tags/:id", () => {
	it("returns 200 and removes the tag", async () => {
		const id = "44444444-4444-4444-8444-444444444444";
		getState().tags.set(id, {
			id,
			ownerId: OWNER_ID,
			name: "trash-me",
			color: null,
			createdAt: new Date(),
		});

		const res = await authedDelete(`/api/tags/${id}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true });
		expect(getState().tags.has(id)).toBe(false);
	});

	it("does not delete tags owned by other users", async () => {
		const id = "55555555-5555-4555-8555-555555555555";
		getState().tags.set(id, {
			id,
			ownerId: "00000000-0000-4000-8000-000000000999",
			name: "not-mine",
			color: null,
			createdAt: new Date(),
		});

		const res = await authedDelete(`/api/tags/${id}`);
		// The handler does not 404 on foreign tags — it returns success without deleting.
		expect(res.status).toBe(200);
		expect(getState().tags.has(id)).toBe(true);
	});
});

describe("POST /api/documents/:id/tags", () => {
	const docId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const tagId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

	function seed() {
		const state = getState();
		state.documents.set(docId, {
			id: docId,
			ownerId: OWNER_ID,
			folderId: null,
			title: "Doc",
			content: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		state.tags.set(tagId, {
			id: tagId,
			ownerId: OWNER_ID,
			name: "label",
			color: null,
			createdAt: new Date(),
		});
	}

	it("returns 400 when tagId is missing or invalid", async () => {
		seed();
		const res = await authedPost(`/api/documents/${docId}/tags`, {});
		expect(res.status).toBe(400);
		expect((res.body as any).error).toBe("Invalid input");
	});

	it("returns 404 when the document does not exist", async () => {
		const res = await authedPost(
			"/api/documents/00000000-0000-4000-8000-000000000099/tags",
			{ tagId },
		);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Document not found");
	});

	it("adds a tag to a document and returns 201", async () => {
		seed();
		const res = await authedPost(`/api/documents/${docId}/tags`, { tagId });
		expect(res.status).toBe(201);
		expect(res.body).toEqual({ success: true });
		// Note: this route uses `db.insert(documentTags).values(...)` without
		// `.returning()`, so the mock harness does not persist the row into
		// state.documentTags. The HTTP response is the contract under test.
	});

	it("does not add tags to documents owned by other users", async () => {
		const state = getState();
		state.documents.set(docId, {
			id: docId,
			ownerId: "00000000-0000-4000-8000-000000000999",
			folderId: null,
			title: "Other",
			content: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		state.tags.set(tagId, {
			id: tagId,
			ownerId: OWNER_ID,
			name: "label",
			color: null,
			createdAt: new Date(),
		});

		const res = await authedPost(`/api/documents/${docId}/tags`, { tagId });
		expect(res.status).toBe(404);
		expect(getState().documentTags.length).toBe(0);
	});
});

describe("DELETE /api/documents/:id/tags/:tagId", () => {
	const docId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
	const tagId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

	function seed() {
		const state = getState();
		state.documents.set(docId, {
			id: docId,
			ownerId: OWNER_ID,
			folderId: null,
			title: "Doc",
			content: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		state.tags.set(tagId, {
			id: tagId,
			ownerId: OWNER_ID,
			name: "label",
			color: null,
			createdAt: new Date(),
		});
		state.documentTags.push({ documentId: docId, tagId });
	}

	it("returns 404 when the document does not exist", async () => {
		const res = await authedDelete(
			`/api/documents/00000000-0000-4000-8000-000000000099/tags/${tagId}`,
		);
		expect(res.status).toBe(404);
		expect((res.body as any).error).toBe("Document not found");
	});

	it("removes a tag from a document", async () => {
		seed();
		const res = await authedDelete(`/api/documents/${docId}/tags/${tagId}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true });
		// Note: this route uses `db.delete(documentTags).where(...)` without
		// `.returning()`, so the mock harness does not mutate state.documentTags.
		// The HTTP response is the contract under test.
	});

	it("does not remove tags from documents owned by other users", async () => {
		const state = getState();
		state.documents.set(docId, {
			id: docId,
			ownerId: "00000000-0000-4000-8000-000000000999",
			folderId: null,
			title: "Other",
			content: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		state.tags.set(tagId, {
			id: tagId,
			ownerId: OWNER_ID,
			name: "label",
			color: null,
			createdAt: new Date(),
		});
		state.documentTags.push({ documentId: docId, tagId });

		const res = await authedDelete(`/api/documents/${docId}/tags/${tagId}`);
		expect(res.status).toBe(404);
		expect(getState().documentTags.length).toBe(1);
	});
});