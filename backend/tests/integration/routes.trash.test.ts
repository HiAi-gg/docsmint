import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
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

let app: any;

beforeAll(async () => {
	app = (await setupHarness()).app;
});

beforeEach(() => resetState());

function seedDocument(id: string, ownerId = OWNER_ID) {
	const now = new Date("2024-06-01T00:00:00Z");
	const document = {
		id,
		ownerId,
		workspaceId: null,
		folderId: null,
		categoryId: null,
		title: `Trash ${id.slice(-4)}`,
		content: "trash contract",
		contentJson: null,
		metadata: null,
		deletedAt: null,
		createdAt: now,
		updatedAt: now,
	};
	getState().documents.set(id, document);
	return document;
}

const get = (path: string, headers = ownerHeaders()) =>
	request(app, path, { method: "GET", headers });
const remove = (path: string, headers = ownerHeaders()) =>
	request(app, path, { method: "DELETE", headers });
const post = (path: string, headers = ownerHeaders()) =>
	request(app, path, { method: "POST", headers });

describe("Trash contract", () => {
	it("soft deletes out of active list/get and exposes the document only in Trash", async () => {
		const document = seedDocument("00000000-0000-4000-8000-000000000101");
		const deleted = await remove(`/api/documents/${document.id}`);
		expect(deleted.status).toBe(200);

		const activeList = await get("/api/documents");
		expect(activeList.status).toBe(200);
		expect(
			(activeList.body as any).items.some((row: any) => row.id === document.id),
		).toBe(false);
		expect((await get(`/api/documents/${document.id}`)).status).toBe(404);

		const trash = await get("/api/trash");
		expect(trash.status).toBe(200);
		expect((trash.body as any).documents.map((row: any) => row.id)).toContain(
			document.id,
		);
	});

	it("restores a document into active requests", async () => {
		const document = seedDocument("00000000-0000-4000-8000-000000000102");
		await remove(`/api/documents/${document.id}`);
		const restored = await post(`/api/trash/documents/${document.id}/restore`);
		expect(restored.status).toBe(200);
		expect(getState().documents.get(document.id)?.deletedAt).toBeNull();
		expect((await get(`/api/documents/${document.id}`)).status).toBe(200);
	});

	it("permanently purges only a trashed document", async () => {
		const document = seedDocument("00000000-0000-4000-8000-000000000103");
		await remove(`/api/documents/${document.id}`);
		expect((await remove(`/api/trash/documents/${document.id}`)).status).toBe(
			200,
		);
		expect(getState().documents.has(document.id)).toBe(false);
		expect((await remove(`/api/trash/documents/${document.id}`)).status).toBe(
			404,
		);
	});

	it("does not expose or mutate another owner's Trash", async () => {
		const document = seedDocument(
			"00000000-0000-4000-8000-000000000104",
			OTHER_USER_ID,
		);
		document.deletedAt = new Date("2024-06-02T00:00:00Z");
		expect((await get("/api/trash")).status).toBe(200);
		expect((await get("/api/trash")).body).toMatchObject({ documents: [] });
		expect(
			(await post(`/api/trash/documents/${document.id}/restore`)).status,
		).toBe(404);
		expect((await remove(`/api/trash/documents/${document.id}`)).status).toBe(
			404,
		);
		expect(getState().documents.has(document.id)).toBe(true);
	});

	it("rejects unauthenticated Trash access", async () => {
		const document = seedDocument("00000000-0000-4000-8000-000000000105");
		document.deletedAt = new Date();
		const headers = noAuthHeaders();
		expect((await get("/api/trash", headers)).status).toBe(401);
		expect(
			(await post(`/api/trash/documents/${document.id}/restore`, headers))
				.status,
		).toBe(403);
		expect(
			(await remove(`/api/trash/documents/${document.id}`, headers)).status,
		).toBe(403);
	});

	it("resolves concurrent restore and purge deterministically", async () => {
		const document = seedDocument("00000000-0000-4000-8000-000000000106");
		await remove(`/api/documents/${document.id}`);
		const [restore, purge] = await Promise.all([
			post(`/api/trash/documents/${document.id}/restore`),
			remove(`/api/trash/documents/${document.id}`),
		]);
		expect([restore.status, purge.status].sort()).toEqual([200, 404]);
		expect(getState().documents.has(document.id)).toBe(restore.status === 200);
	});
});
