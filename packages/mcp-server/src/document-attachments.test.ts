import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { DocsClient } from '@hiai-docs/sdk';
import { createDocsmintMcpServer } from './server.js';
import { createMcpDocsClient } from './client.js';

const documentId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const contentBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCdwAAAAASUVORK5CYII=';
const filename = 'fixture.png';
const mimeType = 'image/png';
const image = Buffer.from(contentBase64, 'base64');
const url = `/api/attachments/${attachmentId}/raw`;

test('uploads, embeds, rereads and opens an image through MCP', async () => {
  let object: Uint8Array | undefined;
  let confirmed = false;
  let opened = 0;
  const record = { id: attachmentId, documentId, filename, mimeType, size: image.length, url };
  let document = {
    id: documentId, title: 'Attachment test', content: 'Initial', categoryId: null, folderId: null,
    visibility: 'private', ownerId: otherId, tags: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
  const rest = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request, server) {
    const route = new URL(request.url).pathname;
    if (route === '/object' && request.method === 'PUT') {
      object = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 200 });
    }
    if (request.headers.get('authorization') !== 'Bearer test-key')
      return new Response(null, { status: 401 });
    const path = `/api/documents/${documentId}`;
    if (route === path + '/attachments/presign') {
      expect(await request.json()).toEqual({ filename, contentType: mimeType, size: image.length });
      return Response.json({ url: new URL('/object', server.url), key: 'image-key', uploadToken: 'upload-test' });
    }
    if (route === path + '/attachments/confirm') {
      expect(await request.json()).toMatchObject({ key: 'image-key', uploadToken: 'upload-test' });
      expect(Buffer.from(object!)).toEqual(image);
      confirmed = true;
      return Response.json(record);
    }
    if (route === path + '/attachments')
      return Response.json({ items: confirmed ? [record] : [] });
    if (route === url && confirmed) {
      opened++;
      return new Response(Uint8Array.from(object!), { headers: { 'Content-Type': mimeType } });
    }
    if (route === path) {
      if (request.method !== 'GET') document = { ...document, ...await request.json() };
      return Response.json(document);
    }
    return new Response(null, { status: 404 });
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createDocsmintMcpServer({ docsClient: new DocsClient({ baseUrl: rest.url.origin, apiKey: 'test-key' }) });
  const client = new Client({ name: 'attachments-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const invalid = await client.callTool({ name: 'upload_document_image', arguments: { documentId, filename, mimeType, contentBase64: 'data:image/png;base64,abc' } }).catch(() => null);
    expect(!invalid || invalid.isError).toBeTruthy();
    const mismatched = await client.callTool({ name: 'upload_document_image', arguments: { documentId, filename, mimeType: 'image/jpeg', contentBase64 } });
    expect(mismatched.isError).toBe(true);
    expect(JSON.parse((mismatched.content[0] as { text: string }).text).code).toBe("IMAGE_MIME_MISMATCH");
    expect(object).toBeUndefined();
    const oversized = await client.callTool({ name: 'upload_document_image', arguments: {
      documentId, filename, mimeType, contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'),
    } });
    expect(oversized.isError).toBe(true);
    expect(JSON.parse((oversized.content[0] as { text: string }).text).code).toBe('IMAGE_TOO_LARGE');
    const uploaded = await client.callTool({ name: 'upload_document_image', arguments: { documentId, filename, mimeType, contentBase64 } });
    expect(uploaded.structuredContent).toEqual(record);
    const content = `![Fixture](${url})`;
    const saved = await client.callTool({ name: 'save_document', arguments: { action: 'update', id: documentId, content } });
    expect(saved.isError).not.toBe(true);
    const read = await client.callTool({ name: 'read_document', arguments: { view: 'detail', id: documentId } });
    expect(read.structuredContent).toMatchObject({ result: { content } });
    const foreign = await client.callTool({ name: 'check_document_attachments', arguments: { documentId, attachmentId: otherId } });
    expect(foreign.isError).toBe(true);
    expect(opened).toBe(0);
    const checked = await client.callTool({ name: 'check_document_attachments', arguments: { documentId, attachmentId } });
    expect(checked.isError, JSON.stringify(checked.content)).not.toBe(true);
    expect(checked.structuredContent).toEqual({ items: [record], verifiedAttachmentId: attachmentId, verification: { size: image.length, mimeType, sha256: new Bun.CryptoHasher('sha256').update(image).digest('hex') } });
    expect(opened).toBe(1);
    confirmed = false;
    const deleted = await client.callTool({ name: 'check_document_attachments', arguments: { documentId, attachmentId } });
    expect(deleted.isError).toBe(true);
    expect(JSON.parse((deleted.content[0] as { text: string }).text).code).toBe('ATTACHMENT_NOT_FOUND');
    expect(opened).toBe(1);
  } finally {
    await client.close();
    await server.close();
    rest.stop(true);
  }
});

test("MCP retry keeps source checksum and operation identity and skips a second PUT after confirmation", async () => {
	let puts = 0;
	let completed = false;
	const receipt = {
		id: attachmentId,
		filename: "fixture.webp",
		mimeType: "image/webp",
		size: 42,
		url,
	};
	const rest = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request, server) {
			const route = new URL(request.url).pathname;
			if (route === "/object") {
				puts++;
				expect(Buffer.from(await request.arrayBuffer())).toEqual(image);
				return new Response(null);
			}
			if (route.endsWith("/presign")) {
				expect(request.headers.get("Idempotency-Key")).toBe(
					"same-image-operation",
				);
				expect(await request.json()).toEqual({
					filename,
					contentType: mimeType,
					size: image.length,
					sourceSha256: new Bun.CryptoHasher("sha256")
						.update(image)
						.digest("hex"),
				});
				return Response.json({
					key: "same-key",
					uploadToken: "same-token",
					url: completed ? "" : new URL("/object", server.url),
					alreadyConfirmed: completed,
				});
			}
			if (route.endsWith("/confirm")) {
				expect(await request.json()).toMatchObject({
					key: "same-key",
					uploadToken: "same-token",
				});
				completed = true;
				return Response.json(receipt);
			}
			return new Response(null, { status: 404 });
		},
	});
	try {
		const client = createMcpDocsClient(
			new DocsClient({ baseUrl: rest.url.origin, apiKey: "test" }),
		);
		const upload = () =>
			client.uploadDocumentImage!(
				documentId,
				filename,
				mimeType,
				image,
				"same-image-operation",
			);
		expect(await upload()).toEqual(receipt);
		expect(await upload()).toEqual(receipt);
		expect(puts).toBe(1);
	} finally {
		rest.stop(true);
	}
});
