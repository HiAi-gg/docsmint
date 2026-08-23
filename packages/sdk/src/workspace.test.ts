import { describe, expect, test } from "bun:test";
import type {
	WorkspaceAssertionPayload as ConsumerWorkspaceAssertionPayload,
	WorkspaceResourceScope as ConsumerWorkspaceResourceScope,
} from "@hiai-docs/sdk/workspace";
import {
	createDocsmintWorkspaceAssertion,
	verifyDocsmintWorkspaceAssertion,
} from "./workspace.js";

const context = {
	actorUserId: "018f37c8-6b15-7b9e-8c44-9e4a86cf1161",
	workspaceId: "ws_opaque_123",
	actorRole: "owner" as const,
	issuedAt: 1_700_000_000,
	expiresAt: 1_700_000_060,
	issuer: "docsmint-com",
};
const options = {
	secret: "test-secret",
	issuer: "docsmint-com",
	nowSeconds: 1_700_000_030,
};

const scopedContext = {
	...context,
	resourceScope: {
		kind: "category" as const,
		categoryId: "11111111-1111-4111-8111-111111111111",
		permissions: ["read", "write"] as const,
	},
};

async function signedPayload(payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(options.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	return `${payload}.${Buffer.from(signature).toString("base64url")}`;
}

describe("workspace assertions", () => {
	test("exposes the server-only workspace contract through the package subpath", async () => {
		const manifest = (await Bun.file(
			new URL("../package.json", import.meta.url),
		).json()) as {
			exports: Record<string, unknown>;
		};
		expect(manifest.exports["./workspace"]).toEqual({
			import: "./dist/workspace.js",
			types: "./src/workspace.ts",
		});

		const resourceScope: ConsumerWorkspaceResourceScope =
			scopedContext.resourceScope;
		const payload: ConsumerWorkspaceAssertionPayload = {
			...scopedContext,
			resourceScope,
		};
		expect(payload.resourceScope?.categoryId).toBe(
			scopedContext.resourceScope.categoryId,
		);
	});

	test("signs and verifies an HMAC assertion", async () => {
		const assertion = await createDocsmintWorkspaceAssertion(
			context,
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(assertion, options),
		).resolves.toEqual(context);
	});

	test("signs a strict category scope and returns a deeply frozen copy", async () => {
		const assertion = await createDocsmintWorkspaceAssertion(
			scopedContext as never,
			options.secret,
		);
		const verified = await verifyDocsmintWorkspaceAssertion(assertion, options);
		expect(verified).toEqual(scopedContext);
		expect(Object.isFrozen(verified)).toBe(true);
		expect(
			Object.isFrozen((verified as typeof scopedContext).resourceScope),
		).toBe(true);
		expect(
			Object.isFrozen(
				(verified as typeof scopedContext).resourceScope.permissions,
			),
		).toBe(true);
	});

	test("rejects unknown assertion and category-scope fields exactly", async () => {
		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, unexpected: true } as never,
				options.secret,
			),
		).rejects.toThrow("Invalid workspace assertion payload fields");
		await expect(
			createDocsmintWorkspaceAssertion(
				{
					...scopedContext,
					resourceScope: { ...scopedContext.resourceScope, unexpected: true },
				} as never,
				options.secret,
			),
		).rejects.toThrow("Invalid workspace resource scope fields");

		const unknownPayload = Buffer.from(
			JSON.stringify({ ...context, unexpected: true }),
		).toString("base64url");
		await expect(
			verifyDocsmintWorkspaceAssertion(
				await signedPayload(unknownPayload),
				options,
			),
		).rejects.toThrow("Invalid workspace assertion payload fields");
	});

	test("rejects invalid category ids and permissions but permits an empty set", async () => {
		await expect(
			createDocsmintWorkspaceAssertion(
				{
					...scopedContext,
					resourceScope: { ...scopedContext.resourceScope, kind: "folder" },
				} as never,
				options.secret,
			),
		).rejects.toThrow("Invalid workspace resource scope kind");
		await expect(
			createDocsmintWorkspaceAssertion(
				{
					...scopedContext,
					resourceScope: {
						...scopedContext.resourceScope,
						categoryId: "category-1",
					},
				} as never,
				options.secret,
			),
		).rejects.toThrow("Invalid workspace resource categoryId");
		await expect(
			createDocsmintWorkspaceAssertion(
				{
					...scopedContext,
					resourceScope: {
						...scopedContext.resourceScope,
						permissions: ["read", "delete"],
					},
				} as never,
				options.secret,
			),
		).rejects.toThrow("Invalid workspace resource permissions");

		const emptyPermissions = {
			...scopedContext,
			resourceScope: { ...scopedContext.resourceScope, permissions: [] },
		};
		const assertion = await createDocsmintWorkspaceAssertion(
			emptyPermissions as never,
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(assertion, options),
		).resolves.toEqual(emptyPermissions);
	});

	test("rejects sparse permissions during creation and verification", async () => {
		const sparsePermissions = Array(1);
		await expect(
			createDocsmintWorkspaceAssertion(
				{
					...scopedContext,
					resourceScope: {
						...scopedContext.resourceScope,
						permissions: sparsePermissions,
					},
				} as never,
				options.secret,
			),
		).rejects.toThrow("Invalid workspace resource permissions");

		const sparsePayload = Buffer.from(
			JSON.stringify({
				...scopedContext,
				resourceScope: {
					...scopedContext.resourceScope,
					permissions: sparsePermissions,
				},
			}),
		).toString("base64url");
		await expect(
			verifyDocsmintWorkspaceAssertion(
				await signedPayload(sparsePayload),
				options,
			),
		).rejects.toThrow("Invalid workspace resource permissions");
	});

	test("authenticates category and permission bytes before validation", async () => {
		const assertion = await createDocsmintWorkspaceAssertion(
			scopedContext as never,
			options.secret,
		);
		const [payload, signature] = assertion.split(".");
		if (!payload || !signature) throw new Error("invalid test assertion");
		const decoded = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		for (const resourceScope of [
			{
				...decoded.resourceScope,
				categoryId: "22222222-2222-4222-8222-222222222222",
			},
			{ ...decoded.resourceScope, permissions: ["edit"] },
		]) {
			const tamperedPayload = Buffer.from(
				JSON.stringify({ ...decoded, resourceScope }),
			).toString("base64url");
			await expect(
				verifyDocsmintWorkspaceAssertion(
					`${tamperedPayload}.${signature}`,
					options,
				),
			).rejects.toThrow("signature");
		}
	});

	test("rejects an extra segment, a wrong secret, and a future assertion", async () => {
		const assertion = await createDocsmintWorkspaceAssertion(
			context,
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(`${assertion}.extra`, options),
		).rejects.toThrow();
		await expect(
			verifyDocsmintWorkspaceAssertion(assertion, {
				...options,
				secret: "wrong",
			}),
		).rejects.toThrow();
		const future = await createDocsmintWorkspaceAssertion(
			{ ...context, issuedAt: 1_700_001_000, expiresAt: 1_700_001_060 },
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(future, options),
		).rejects.toThrow();
	});

	test("rejects wrong issuer, expired assertions, and excessive TTL", async () => {
		const wrongIssuer = await createDocsmintWorkspaceAssertion(
			{ ...context, issuer: "other-host" },
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(wrongIssuer, options),
		).rejects.toThrow("issuer");

		const expired = await createDocsmintWorkspaceAssertion(
			{ ...context, issuedAt: 1_699_999_000, expiresAt: 1_699_999_060 },
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(expired, options),
		).rejects.toThrow("expired");

		const excessiveTtl = await createDocsmintWorkspaceAssertion(
			{ ...context, expiresAt: context.issuedAt + 60 },
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(excessiveTtl, options),
		).resolves.toEqual(context);
		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, expiresAt: context.issuedAt + 61 },
				options.secret,
			),
		).rejects.toThrow("maximum TTL");
	});

	test("accepts only the documented five-second clock skew", async () => {
		const withinSkew = await createDocsmintWorkspaceAssertion(
			{
				...context,
				issuedAt: options.nowSeconds + 5,
				expiresAt: options.nowSeconds + 30,
			},
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(withinSkew, options),
		).resolves.toMatchObject({ actorUserId: context.actorUserId });

		const outsideSkew = await createDocsmintWorkspaceAssertion(
			{
				...context,
				issuedAt: options.nowSeconds + 6,
				expiresAt: options.nowSeconds + 30,
			},
			options.secret,
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(outsideSkew, options),
		).rejects.toThrow("not yet valid");
	});

	test("rejects malformed base64url, malformed JSON, invalid role, and missing workspace", async () => {
		await expect(
			verifyDocsmintWorkspaceAssertion("%%%.signature", options),
		).rejects.toThrow();

		const malformedJsonPayload = Buffer.from("{", "utf8").toString("base64url");
		await expect(
			verifyDocsmintWorkspaceAssertion(
				await signedPayload(malformedJsonPayload),
				options,
			),
		).rejects.toThrow("payload");

		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, actorRole: "billing" } as typeof context,
				options.secret,
			),
		).rejects.toThrow("actorRole");
		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, workspaceId: "" },
				options.secret,
			),
		).rejects.toThrow("workspaceId");
	});
});
