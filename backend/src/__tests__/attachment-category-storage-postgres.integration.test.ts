import { expect, test } from "bun:test";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Elysia } from "elysia";
import postgres from "postgres";
import sharp from "sharp";

const ownerUrl = Bun.env.CONTENT_ACCESS_TEST_DATABASE_URL;

test.skipIf(!ownerUrl || Bun.env.ATTACHMENT_LIVE_STORAGE_TEST !== "true")(
	"category/read raw bytes use real RLS and storage and deny foreign/revoked/write access",
	async () => {
		const { attachmentRoutes } = await import("../api/routes/attachments");
		const { createApiKey, revokeApiKey } = await import("../lib/api-keys");
		const { storage, BUCKET } = await import("../lib/storage");
		const setup = postgres(ownerUrl!, { max: 1, onnotice: () => {} });
		const actor = crypto.randomUUID();
		const other = crypto.randomUUID();
		const category = crypto.randomUUID();
		const adjacent = crypto.randomUUID();
		const ownDoc = crypto.randomUUID();
		const adjacentDoc = crypto.randomUUID();
		const foreignDoc = crypto.randomUUID();
		const attachmentIds = [
			crypto.randomUUID(),
			crypto.randomUUID(),
			crypto.randomUUID(),
		];
		const keys = attachmentIds.map(
			(id) => `synthetic-category-acceptance/${id}.webp`,
		);
		const app = new Elysia().use(attachmentRoutes);
		const bytes = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 4,
				background: { r: 10, g: 40, b: 80, alpha: 0.5 },
			},
		})
			.webp({ lossless: true })
			.toBuffer();
		try {
			await setup`INSERT INTO users (id, email) VALUES (${actor}::uuid, ${actor + "@raw.invalid"}), (${other}::uuid, ${other + "@raw.invalid"})`;
			await setup`INSERT INTO categories (id, owner_id, name, api_mode, api_permission_read, api_permission_edit, api_permission_write)
      VALUES (${category}::uuid, ${actor}::uuid, 'Published synthetic', 'category', true, false, false),
             (${adjacent}::uuid, ${actor}::uuid, 'Adjacent synthetic', 'category', true, false, false)`;
			await setup`INSERT INTO documents (id, owner_id, category_id, title, content) VALUES
      (${ownDoc}::uuid, ${actor}::uuid, ${category}::uuid, 'Synthetic own', ''),
      (${adjacentDoc}::uuid, ${actor}::uuid, ${adjacent}::uuid, 'Synthetic adjacent', ''),
      (${foreignDoc}::uuid, ${other}::uuid, null, 'Synthetic foreign', '')`;
			for (let i = 0; i < attachmentIds.length; i++) {
				await storage.send(
					new PutObjectCommand({
						Bucket: BUCKET,
						Key: keys[i],
						Body: bytes,
						ContentType: "image/webp",
					}),
				);
				await setup`INSERT INTO attachments (id, document_id, filename, mime_type, size, storage_key)
        VALUES (${attachmentIds[i]!}::uuid, ${[ownDoc, adjacentDoc, foreignDoc][i]!}::uuid, 'synthetic.webp', 'image/webp', ${bytes.length}, ${keys[i]!})`;
			}
			const issued = await createApiKey(actor, "synthetic read acceptance", [
				`category:${category}:read`,
			]);
			const headers = { authorization: `Bearer ${issued.key}` };
			const get = (path: string) =>
				app.handle(new Request("http://localhost/api/" + path, { headers }));
			const raw = await get(`attachments/${attachmentIds[0]}/raw`);
			expect(raw.status).toBe(200);
			expect(raw.headers.get("content-type")).toContain("image/webp");
			expect(Buffer.from(await raw.arrayBuffer())).toEqual(bytes);
			expect((await get(`documents/${ownDoc}/attachments`)).status).toBe(200);
			for (const id of attachmentIds.slice(1))
				expect((await get(`attachments/${id}/raw`)).status).toBe(404);
			const write = await app.handle(
				new Request(
					`http://localhost/api/documents/${ownDoc}/attachments/presign`,
					{
						method: "POST",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify({
							filename: "blocked.png",
							contentType: "image/png",
							size: 10,
						}),
					},
				),
			);
			expect(write.status).toBe(404); // Missing edit permission masks document existence.
			expect(await revokeApiKey(issued.id, actor)).toBe(true);
			expect((await get(`attachments/${attachmentIds[0]}/raw`)).status).toBe(
				401,
			);
		} finally {
			for (const Key of keys)
				await storage
					.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }))
					.catch(() => {});
			await setup`DELETE FROM attachments WHERE id IN (${attachmentIds[0]!}::uuid, ${attachmentIds[1]!}::uuid, ${attachmentIds[2]!}::uuid)`;
			await setup`DELETE FROM users WHERE id IN (${actor}::uuid, ${other}::uuid)`;
			await setup.end();
		}
	},
	30_000,
);
