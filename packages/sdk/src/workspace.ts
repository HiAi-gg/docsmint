/** Public, server-only workspace assertion contract. */
export const DOCSMINT_WORKSPACE_CONTEXT_HEADER = "x-docsmint-workspace-context";
/** @deprecated Compatibility header accepted only during 0.3.x. */
export const EXTERNAL_TENANT_CONTEXT_HEADER = "x-hiai-tenant-context";

export type DocsmintWorkspaceContext = Readonly<{
	actorUserId: string;
	workspaceId: string;
	actorRole: "owner" | "admin" | "editor" | "viewer";
	issuedAt: number;
	expiresAt: number;
	issuer: string;
}>;

export type WorkspaceAssertionOptions = Readonly<{
	secret: string;
	issuer: string;
	nowSeconds?: number;
	clockSkewSeconds?: number;
	maxTtlSeconds?: number;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_TTL_SECONDS = 300;

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
	const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sign(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

function assertContext(value: unknown): asserts value is DocsmintWorkspaceContext {
	if (!value || typeof value !== "object") throw new Error("Invalid workspace assertion payload");
	const context = value as Record<string, unknown>;
	if (typeof context.actorUserId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.actorUserId)) throw new Error("Invalid actorUserId");
	if (typeof context.workspaceId !== "string" || !context.workspaceId.trim() || context.workspaceId.trim() !== context.workspaceId || context.workspaceId.length > 128) throw new Error("Invalid workspaceId");
	if (!(["owner", "admin", "editor", "viewer"] as const).includes(context.actorRole as never)) throw new Error("Invalid actorRole");
	if (!Number.isFinite(context.issuedAt) || !Number.isFinite(context.expiresAt) || typeof context.issuer !== "string" || !context.issuer) throw new Error("Invalid workspace assertion timestamps or issuer");
}

export async function createDocsmintWorkspaceAssertion(context: DocsmintWorkspaceContext, secret: string): Promise<string> {
	assertContext(context);
	const payload = toBase64Url(encoder.encode(JSON.stringify(context)));
	return `${payload}.${await sign(payload, secret)}`;
}

export async function verifyDocsmintWorkspaceAssertion(assertion: string, options: WorkspaceAssertionOptions): Promise<DocsmintWorkspaceContext> {
	const [payload, signature, ...extra] = assertion.split(".");
	if (!payload || !signature || extra.length) throw new Error("Invalid workspace assertion format");
	const key = await crypto.subtle.importKey("raw", encoder.encode(options.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(signature) as BufferSource, encoder.encode(payload));
	if (!valid) throw new Error("Invalid workspace assertion signature");
	let context: unknown;
	try { context = JSON.parse(decoder.decode(fromBase64Url(payload))); } catch { throw new Error("Invalid workspace assertion payload"); }
	assertContext(context);
	if (context.issuer !== options.issuer) throw new Error("Invalid workspace assertion issuer");
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const skew = options.clockSkewSeconds ?? 5;
	if (context.issuedAt > now + skew || context.expiresAt <= now - skew || context.expiresAt <= context.issuedAt || context.expiresAt - context.issuedAt > (options.maxTtlSeconds ?? MAX_TTL_SECONDS)) throw new Error("Invalid workspace assertion lifetime");
	return Object.freeze({ ...context });
}
