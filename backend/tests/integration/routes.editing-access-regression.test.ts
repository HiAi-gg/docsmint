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
	OWNER_ID,
	ownerHeaders,
	request,
	resetState,
	setupHarness,
} from "./_harness";

const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
const DOC_ID = "00000000-0000-4000-8000-0000000000aa";
const ATTACHMENT_ID = "00000000-0000-4000-8000-0000000000cc";
const STORAGE_KEY = `${OWNER_ID}/${DOC_ID}/seeded.png`;
const CATEGORY_WRITE_KEY = "test-category-write-key-32charsxxx";

let app: { handle: (request: Request) => Promise<Response> };

beforeAll(async () => {
	const built = await setupHarness();
	app = built.app;
});

beforeEach(() => {
	resetState();
	getStorageMockState().removeObjectShouldThrow = false;
	getStorageMockState().removedKeys.length = 0;
	getState().apiKeys.set(CATEGORY_WRITE_KEY, {
		id: "write-key",
		ownerId: OWNER_ID,
		scopes: [`category:${CATEGORY_ID}:write`],
	});
});

afterEach(() => {
	resetState();
	getStorageMockState().removeObjectShouldThrow = false;
	getStorageMockState().removedKeys.length = 0;
});

function bearerHeaders(token: string) {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
}

describe("0.8.3 editing and access HTTP regression", () => {
	it("preserves omitted category API permissions on name-only PATCH", async () => {
		getState().categories.set("cat-1", {
			id: "cat-1",
			ownerId: OWNER_ID,
			name: "old",
			apiMode: "global",
			apiPermissionRead: true,
			apiPermissionEdit: false,
			apiPermissionWrite: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const res = await request(app, "/api/categories/cat-1", {
			method: "PATCH",
			headers: ownerHeaders(),
			body: JSON.stringify({ name: "renamed" }),
		});
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			name: "renamed",
			apiMode: "global",
			apiPermissionRead: true,
			apiPermissionEdit: false,
			apiPermissionWrite: true,
		});
		expect(getState().categories.get("cat-1")).toMatchObject({
			apiPermissionRead: true,
			apiPermissionEdit: false,
			apiPermissionWrite: true,
		});
	});

	it("rejects workspace tag creation from a category-scoped write key", async () => {
		const denied = await request(app, "/api/tags", {
			method: "POST",
			headers: bearerHeaders(CATEGORY_WRITE_KEY),
			body: JSON.stringify({ name: "scoped" }),
		});
		expect(denied.status).toBe(403);
		expect(denied.body).toMatchObject({
			error: "Full workspace write access required",
		});
		expect(getState().tags.size).toBe(0);

		const allowed = await request(app, "/api/tags", {
			method: "POST",
			headers: ownerHeaders(),
			body: JSON.stringify({ name: "workspace" }),
		});
		expect(allowed.status).toBe(201);
		expect(getState().tags.size).toBe(1);
	});

	it("keeps attachment storage identity on cleanup after object removal fails", async () => {
		getState().documents.set(DOC_ID, {
			id: DOC_ID,
			ownerId: OWNER_ID,
			title: "Test doc",
			folderId: null,
			categoryId: CATEGORY_ID,
			createdAt: new Date(),
			updatedAt: new Date(),
			contentJson: null,
			content: "",
		});
		getState().attachments.set(ATTACHMENT_ID, {
			id: ATTACHMENT_ID,
			documentId: DOC_ID,
			filename: "seeded.png",
			mimeType: "image/png",
			size: 1024,
			storageKey: STORAGE_KEY,
			ownerId: OWNER_ID,
			uploadedBy: OWNER_ID,
			workspaceId: null,
		});
		getStorageMockState().removeObjectShouldThrow = true;
		const res = await request(app, `/api/attachments/${ATTACHMENT_ID}`, {
			method: "DELETE",
			headers: ownerHeaders(),
		});
		expect(res.status).toBe(200);
		const cleanup = [...getState().attachmentStorageCleanupOutbox.values()];
		expect(cleanup).toHaveLength(1);
		expect(cleanup[0]?.storageKey).toBe(STORAGE_KEY);
		expect(cleanup[0]?.sourceId).toBe(ATTACHMENT_ID);
	});

});
