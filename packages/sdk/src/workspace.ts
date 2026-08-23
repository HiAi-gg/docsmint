/** Public, server-only workspace assertion contract. */
export const DOCSMINT_WORKSPACE_CONTEXT_HEADER = "x-docsmint-workspace-context";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";
export type WorkspaceResourcePermission = "read" | "edit" | "write";
export type WorkspaceResourceScope = Readonly<{
	kind: "category";
	categoryId: string;
	permissions: readonly WorkspaceResourcePermission[];
}>;
export type WorkspaceAssertionPayload = Readonly<{
	actorUserId: string;
	workspaceId: string;
	actorRole: WorkspaceRole;
	resourceScope?: WorkspaceResourceScope;
	issuedAt: number;
	expiresAt: number;
	issuer: string;
}>;
export type DocsmintWorkspaceContext = WorkspaceAssertionPayload;

export type WorkspaceAssertionOptions = Readonly<{
	secret: string;
	issuer: string;
	nowSeconds?: number;
	clockSkewSeconds?: number;
	/** @deprecated Assertion lifetime is fixed at 60 seconds. */
	maxTtlSeconds?: never;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const DOCSMINT_WORKSPACE_ASSERTION_TTL_SECONDS = 60;
export const DOCSMINT_WORKSPACE_ASSERTION_CLOCK_SKEW_SECONDS = 5;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTEXT_FIELDS = new Set([
	"actorUserId",
	"workspaceId",
	"actorRole",
	"resourceScope",
	"issuedAt",
	"expiresAt",
	"issuer",
]);
const RESOURCE_SCOPE_FIELDS = new Set(["kind", "categoryId", "permissions"]);
const RESOURCE_PERMISSIONS = new Set<WorkspaceResourcePermission>([
	"read",
	"edit",
	"write",
]);

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
	const padded =
		value.replaceAll("-", "+").replaceAll("_", "/") +
		"=".repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sign(payload: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toBase64Url(
		new Uint8Array(
			await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
		),
	);
}

function assertContext(
	value: unknown,
): asserts value is DocsmintWorkspaceContext {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid workspace assertion payload");
	const context = value as Record<string, unknown>;
	if (Object.keys(context).some((field) => !CONTEXT_FIELDS.has(field))) {
		throw new Error("Invalid workspace assertion payload fields");
	}
	if (
		typeof context.actorUserId !== "string" ||
		!UUID_PATTERN.test(context.actorUserId)
	)
		throw new Error("Invalid actorUserId");
	if (
		typeof context.workspaceId !== "string" ||
		!context.workspaceId.trim() ||
		context.workspaceId.trim() !== context.workspaceId ||
		context.workspaceId.length > 128
	)
		throw new Error("Invalid workspaceId");
	if (
		!(["owner", "admin", "editor", "viewer"] as const).includes(
			context.actorRole as never,
		)
	)
		throw new Error("Invalid actorRole");
	if (context.resourceScope !== undefined) {
		assertResourceScope(context.resourceScope);
	}
	if (
		!Number.isFinite(context.issuedAt) ||
		!Number.isFinite(context.expiresAt) ||
		typeof context.issuer !== "string" ||
		!context.issuer
	)
		throw new Error("Invalid workspace assertion timestamps or issuer");
}

function assertResourceScope(
	value: unknown,
): asserts value is WorkspaceResourceScope {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid workspace resource scope");
	}
	const scope = value as Record<string, unknown>;
	const fields = Object.keys(scope);
	if (
		fields.length !== RESOURCE_SCOPE_FIELDS.size ||
		fields.some((field) => !RESOURCE_SCOPE_FIELDS.has(field))
	) {
		throw new Error("Invalid workspace resource scope fields");
	}
	if (scope.kind !== "category") {
		throw new Error("Invalid workspace resource scope kind");
	}
	if (
		typeof scope.categoryId !== "string" ||
		!UUID_PATTERN.test(scope.categoryId)
	) {
		throw new Error("Invalid workspace resource categoryId");
	}
	if (
		!Array.isArray(scope.permissions) ||
		Array.from(scope.permissions).some(
			(permission) =>
				typeof permission !== "string" ||
				!RESOURCE_PERMISSIONS.has(permission as WorkspaceResourcePermission),
		)
	) {
		throw new Error("Invalid workspace resource permissions");
	}
}

function assertStaticLifetime(context: DocsmintWorkspaceContext): void {
	if (context.expiresAt <= context.issuedAt) {
		throw new Error("Invalid workspace assertion lifetime");
	}
	if (
		context.expiresAt - context.issuedAt >
		DOCSMINT_WORKSPACE_ASSERTION_TTL_SECONDS
	) {
		throw new Error("Workspace assertion lifetime exceeds maximum TTL");
	}
}

function immutableContext(
	context: DocsmintWorkspaceContext,
): DocsmintWorkspaceContext {
	const resourceScope = context.resourceScope
		? Object.freeze({
				kind: context.resourceScope.kind,
				categoryId: context.resourceScope.categoryId,
				permissions: Object.freeze([...context.resourceScope.permissions]),
			})
		: undefined;
	return Object.freeze({
		actorUserId: context.actorUserId,
		workspaceId: context.workspaceId,
		actorRole: context.actorRole,
		...(resourceScope ? { resourceScope } : {}),
		issuedAt: context.issuedAt,
		expiresAt: context.expiresAt,
		issuer: context.issuer,
	});
}

export async function createDocsmintWorkspaceAssertion(
	context: DocsmintWorkspaceContext,
	secret: string,
): Promise<string> {
	assertContext(context);
	assertStaticLifetime(context);
	const payload = toBase64Url(
		encoder.encode(JSON.stringify(immutableContext(context))),
	);
	return `${payload}.${await sign(payload, secret)}`;
}

export async function verifyDocsmintWorkspaceAssertion(
	assertion: string,
	options: WorkspaceAssertionOptions,
): Promise<DocsmintWorkspaceContext> {
	const [payload, signature, ...extra] = assertion.split(".");
	if (!payload || !signature || extra.length)
		throw new Error("Invalid workspace assertion format");
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(options.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		fromBase64Url(signature) as BufferSource,
		encoder.encode(payload),
	);
	if (!valid) throw new Error("Invalid workspace assertion signature");
	let context: unknown;
	try {
		context = JSON.parse(decoder.decode(fromBase64Url(payload)));
	} catch {
		throw new Error("Invalid workspace assertion payload");
	}
	assertContext(context);
	assertStaticLifetime(context);
	if (context.issuer !== options.issuer)
		throw new Error("Invalid workspace assertion issuer");
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const skew =
		options.clockSkewSeconds ?? DOCSMINT_WORKSPACE_ASSERTION_CLOCK_SKEW_SECONDS;
	if (
		!Number.isSafeInteger(skew) ||
		skew < 0 ||
		skew > DOCSMINT_WORKSPACE_ASSERTION_CLOCK_SKEW_SECONDS
	) {
		throw new Error("Invalid workspace assertion clock skew");
	}
	if (context.issuedAt > now + skew)
		throw new Error("Workspace assertion is not yet valid");
	if (context.expiresAt <= now - skew)
		throw new Error("Workspace assertion is expired");
	return immutableContext(context);
}
