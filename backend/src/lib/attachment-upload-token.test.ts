import { expect, test } from "bun:test";
import {
	attachmentUploadTokenHash,
	signAttachmentUploadToken,
	verifyAttachmentUploadToken,
} from "./attachment-upload-token";

test("direct-upload tokens authenticate every cleanup-authority claim", async () => {
	const claims = {
		id: crypto.randomUUID(),
		documentId: crypto.randomUUID(),
		actorUserId: crypto.randomUUID(),
		workspaceId: `workspace-${crypto.randomUUID()}`,
		storageKey: `workspace/actor/document/${crypto.randomUUID()}.png`,
		expiresAt: Date.now() + 60_000,
	};
	const token = await signAttachmentUploadToken(claims);
	expect(await verifyAttachmentUploadToken(token)).toEqual(claims);
	expect(attachmentUploadTokenHash(token)).toMatch(/^[a-f0-9]{64}$/);

	const [payload, signature] = token.split(".");
	if (!payload || !signature) throw new Error("signed token is malformed");
	const tamperedPayload = Buffer.from(
		JSON.stringify({ ...claims, storageKey: "victim/object.png" }),
	).toString("base64url");
	expect(
		await verifyAttachmentUploadToken(`${tamperedPayload}.${signature}`),
	).toBeNull();
	expect(
		await verifyAttachmentUploadToken(`${payload}.${signature.slice(1)}x`),
	).toBeNull();
});
