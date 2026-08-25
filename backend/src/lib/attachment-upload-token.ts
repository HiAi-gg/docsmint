import { config } from "./config";

const TOKEN_DOMAIN = "docsmint:attachment-upload:v1";

export type AttachmentUploadClaims = Readonly<{
	id: string;
	documentId: string;
	actorUserId: string;
	workspaceId: string | null;
	storageKey: string;
	expiresAt: number;
}>;

function encode(value: Uint8Array | string): string {
	return Buffer.from(value).toString("base64url");
}

function decode(value: string): ArrayBuffer {
	return Uint8Array.from(Buffer.from(value, "base64url")).buffer as ArrayBuffer;
}

async function signingKey(): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(config.STORAGE_SECRET_KEY),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function validClaims(value: unknown): value is AttachmentUploadClaims {
	if (typeof value !== "object" || value === null) return false;
	const claims = value as Record<string, unknown>;
	return (
		typeof claims.id === "string" &&
		typeof claims.documentId === "string" &&
		typeof claims.actorUserId === "string" &&
		(claims.workspaceId === null || typeof claims.workspaceId === "string") &&
		typeof claims.storageKey === "string" &&
		typeof claims.expiresAt === "number" &&
		Number.isFinite(claims.expiresAt)
	);
}

export function attachmentUploadTokenHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export async function signAttachmentUploadToken(
	claims: AttachmentUploadClaims,
): Promise<string> {
	const payload = encode(JSON.stringify(claims));
	const input = new TextEncoder().encode(`${TOKEN_DOMAIN}.${payload}`);
	const signature = await crypto.subtle.sign("HMAC", await signingKey(), input);
	return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifyAttachmentUploadToken(
	token: string,
): Promise<AttachmentUploadClaims | null> {
	const parts = token.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	try {
		const payload = parts[0];
		const valid = await crypto.subtle.verify(
			"HMAC",
			await signingKey(),
			decode(parts[1]),
			new TextEncoder().encode(`${TOKEN_DOMAIN}.${payload}`),
		);
		if (!valid) return null;
		const claims = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		return validClaims(claims) ? claims : null;
	} catch {
		return null;
	}
}
