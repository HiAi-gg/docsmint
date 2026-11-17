import { beforeAll, expect, test } from "bun:test";
import sharp from "sharp";
import {
	getState,
	getStorageMockState,
	OWNER_ID,
	ownerHeaders,
	request,
	resetState,
	setupHarness,
} from "./_harness";

let app: Awaited<ReturnType<typeof setupHarness>>["app"];

beforeAll(async () => {
	app = (await setupHarness()).app;
	const { config } = await import("../../src/lib/config");
	config.DOCSMINT_ATTACHMENT_WEBP_ENABLED = true;
});

test("confirms ten PNGs as WebP and repeats each confirmation without duplicate attachments", async () => {
	resetState();
	const documentId = "00000000-0000-4000-8000-000000000099";
	getState().documents.set(documentId, {
		id: documentId,
		ownerId: OWNER_ID,
		title: "Synthetic image",
		content: "",
		contentJson: null,
		categoryId: null,
		folderId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	for (let index = 0; index < 10; index++) {
		const bytes = await sharp({
			create: {
				width: 4,
				height: 2,
				channels: 4,
				background: { r: 50 + index, g: 90, b: 120, alpha: 0.5 },
			},
		})
			.png()
			.toBuffer();
		const body = {
			filename: `diagram-${index}.png`,
			contentType: "image/png",
			size: bytes.length,
		};
		const signed = await request(
			app,
			`/api/documents/${documentId}/attachments/presign`,
			{
				method: "POST",
				headers: ownerHeaders(),
				body: JSON.stringify(body),
			},
		);
		expect(signed.status).toBe(200);
		const admitted = signed.body as { key: string; uploadToken: string };
		expect(admitted.key).toEndWith(".webp.pending");
		const storage = getStorageMockState();
		storage.objectBytes.set(admitted.key, bytes);
		storage.storedSizes.set(admitted.key, bytes.length);
		storage.getObjectBodyMode = "async-iterable";
		const confirm = () =>
			request(app, `/api/documents/${documentId}/attachments/confirm`, {
				method: "POST",
				headers: ownerHeaders(),
				body: JSON.stringify({ ...body, ...admitted }),
			});
		const confirmed = await confirm();
		expect(confirmed.status).toBe(201);
		const image = confirmed.body as {
			id: string;
			filename: string;
			mimeType: string;
			size: number;
		};
		expect(image).toMatchObject({
			filename: `diagram-${index}.webp`,
			mimeType: "image/webp",
		});
		const row = getState().attachments.get(image.id);
		expect(row.storageKey).toBe(admitted.key.slice(0, -".pending".length));
		const stored = storage.objectBytes.get(row.storageKey)!;
		expect(image.size).toBe(stored.length);
		expect((await sharp(stored).metadata()).format).toBe("webp");
		// The in-memory select adapter flattens rows and does not execute JOINs.
		// Supply the document owner projected by the production raw query.
		row.ownerId = getState().documents.get(documentId)!.ownerId;
		const raw = await app.handle(
			new Request(`http://localhost/api/attachments/${image.id}/raw`, {
				headers: ownerHeaders(),
			}),
		);
		expect(raw.status).toBe(200);
		expect(raw.headers.get("content-type")).toContain("image/webp");
		expect(Buffer.from(await raw.arrayBuffer())).toEqual(stored);
		const puts = storage.putObjectCalls;
		const repeated = await confirm();
		expect(repeated.status).toBe(201);
		expect(repeated.body).toEqual(confirmed.body);
		expect(storage.putObjectCalls).toBe(puts);
		expect(getState().attachments.size).toBe(index + 1);
	}
	expect(getState().documents.get(documentId)?.content).toBe("");
});

test("retries the same admitted upload after the WebP PUT fails", async () => {
	resetState();
	const documentId = "00000000-0000-4000-8000-000000000098";
	getState().documents.set(documentId, {
		id: documentId,
		ownerId: OWNER_ID,
		title: "Temporary storage failure",
		content: "unchanged",
		contentJson: null,
		categoryId: null,
		folderId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	const bytes = await sharp({
		create: { width: 2, height: 2, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const body = {
		filename: "retry.png",
		contentType: "image/png",
		size: bytes.length,
	};
	const signed = await request(
		app,
		`/api/documents/${documentId}/attachments/presign`,
		{
			method: "POST",
			headers: ownerHeaders(),
			body: JSON.stringify(body),
		},
	);
	expect(signed.status).toBe(200);
	const admitted = signed.body as { key: string; uploadToken: string };
	const storage = getStorageMockState();
	storage.objectBytes.set(admitted.key, bytes);
	storage.storedSizes.set(admitted.key, bytes.length);
	storage.getObjectBodyMode = "async-iterable";
	storage.putObjectFailNext = true;
	const confirm = () =>
		request(app, `/api/documents/${documentId}/attachments/confirm`, {
			method: "POST",
			headers: ownerHeaders(),
			body: JSON.stringify({ ...body, ...admitted }),
		});
	expect((await confirm()).status).toBe(503);
	expect(getState().attachments.size).toBe(0);
	expect(getState().pendingAttachmentUploads.size).toBe(1);

	const recovered = await confirm();

	expect(recovered.status).toBe(201);
	expect(getState().attachments.size).toBe(1);
	expect(getState().pendingAttachmentUploads.size).toBe(0);
	expect(getState().documents.get(documentId)?.content).toBe("unchanged");
});
