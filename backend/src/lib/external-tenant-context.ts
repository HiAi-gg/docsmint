/** Canonical, server-to-server workspace assertion header. */
export const DOCSMINT_WORKSPACE_CONTEXT_HEADER = "x-docsmint-workspace-context";
/** @deprecated Compatibility alias accepted during 0.3.x. */
export const EXTERNAL_TENANT_CONTEXT_HEADER = "x-hiai-tenant-context";
export const WORKSPACE_CONTEXT_MAX_LENGTH = 128;
export const WORKSPACE_CONTEXT_MAX_TTL_SECONDS = 300;

export class ExternalTenantContextError extends Error {
	readonly status = 401;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ExternalTenantContextError";
	}
}

export const docsmintWorkspaceContextSchema = {
	actorRole: ["owner", "admin", "editor", "viewer"] as const,
};

export interface DocsmintWorkspaceContext {
	actorUserId: string;
	workspaceId: string;
	actorRole: (typeof docsmintWorkspaceContextSchema.actorRole)[number];
	issuedAt: number;
	expiresAt: number;
	issuer: string;
}

/** @deprecated Use DocsmintWorkspaceContext. */
export type ExternalTenantContext = DocsmintWorkspaceContext;

export interface ExternalTenantAssertionOptions {
	secret: string;
	issuer: string;
	nowSeconds?: number;
	clockSkewSeconds?: number;
	maxTtlSeconds?: number;
}

const encoder = new TextEncoder();

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
	return Buffer.from(value, "base64url").toString("utf8");
}

async function sign(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return Buffer.from(
		await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
	).toString("base64url");
}

function assertContext(
	value: unknown,
): asserts value is DocsmintWorkspaceContext {
	if (!value || typeof value !== "object")
		throw new Error("Invalid tenant context");
	const context = value as Record<string, unknown>;
	if (
		typeof context.actorUserId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			context.actorUserId,
		)
	) {
		throw new Error("Invalid actorUserId");
	}
	if (
		typeof context.workspaceId !== "string" ||
		context.workspaceId.trim().length === 0 ||
		context.workspaceId.trim().length > WORKSPACE_CONTEXT_MAX_LENGTH ||
		context.workspaceId !== context.workspaceId.trim()
	) {
		throw new Error("Invalid workspaceId");
	}
	if (
		typeof context.actorRole !== "string" ||
		!docsmintWorkspaceContextSchema.actorRole.includes(
			context.actorRole as DocsmintWorkspaceContext["actorRole"],
		)
	) {
		throw new Error("Invalid actorRole");
	}
	for (const field of ["issuedAt", "expiresAt"]) {
		if (
			typeof context[field] !== "number" ||
			!Number.isFinite(context[field])
		) {
			throw new Error(`Invalid ${field}`);
		}
	}
	if (typeof context.issuer !== "string" || !context.issuer) {
		throw new Error("Invalid issuer");
	}
}

export async function createDocsmintWorkspaceAssertion(
	context: DocsmintWorkspaceContext,
	secret: string,
): Promise<string> {
	assertContext(context);
	const payload = encode(JSON.stringify(context));
	return `${payload}.${await sign(payload, secret)}`;
}

export async function verifyExternalTenantAssertion(
	assertion: string,
	options: ExternalTenantAssertionOptions,
): Promise<DocsmintWorkspaceContext> {
	const [payload, signature, ...extra] = assertion.split(".");
	if (!payload || !signature || extra.length > 0) {
		throw new Error("Invalid tenant assertion format");
	}
	let signatureValid = false;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(options.secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		signatureValid = await crypto.subtle.verify(
			"HMAC",
			key,
			Buffer.from(signature, "base64url"),
			encoder.encode(payload),
		);
	} catch {
		signatureValid = false;
	}
	if (!signatureValid) {
		throw new Error("Invalid tenant assertion signature");
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(decode(payload));
	} catch {
		throw new Error("Invalid tenant assertion payload");
	}
	assertContext(decoded);
	if (decoded.issuer !== options.issuer)
		throw new Error("Invalid tenant assertion issuer");
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const skew = options.clockSkewSeconds ?? 5;
	if (decoded.issuedAt > now + skew)
		throw new Error("Tenant assertion is not yet valid");
	if (decoded.expiresAt <= now - skew)
		throw new Error("Tenant assertion is expired");
	if (decoded.expiresAt <= decoded.issuedAt)
		throw new Error("Invalid tenant assertion lifetime");
	if (
		decoded.expiresAt - decoded.issuedAt >
		(options.maxTtlSeconds ?? WORKSPACE_CONTEXT_MAX_TTL_SECONDS)
	)
		throw new Error("Tenant assertion lifetime exceeds maximum TTL");
	return decoded;
}

/** @deprecated Use createDocsmintWorkspaceAssertion. */
export const createExternalTenantAssertion = createDocsmintWorkspaceAssertion;
/** Canonical verifier name. */
export const verifyDocsmintWorkspaceAssertion = verifyExternalTenantAssertion;
