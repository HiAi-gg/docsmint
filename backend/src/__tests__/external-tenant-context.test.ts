import { describe, expect, test } from "bun:test";
import { buildTenantContext } from "../api/middleware/tenant";
import { config } from "../lib/config";
import {
	createDocsmintWorkspaceAssertion,
	verifyDocsmintWorkspaceAssertion,
} from "../lib/external-tenant-context";

// The SDK package points at generated dist files that do not exist before a
// package build. Load the real source through Bun's established query-suffixed
// test seam so parity tests stay hermetic without changing runtime exports.
const sdkWorkspace = await import(
	// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
	"../../../packages/sdk/src/workspace.ts?assertion-parity"
);
const {
	createDocsmintWorkspaceAssertion: createSdkAssertion,
	verifyDocsmintWorkspaceAssertion: verifySdkAssertion,
} = sdkWorkspace;

const context = {
	actorUserId: "00000000-0000-4000-8000-000000000001",
	workspaceId: "workspace-1",
	actorRole: "editor" as const,
	issuedAt: 1_700_000_000,
	expiresAt: 1_700_000_060,
	issuer: "docs-mint",
};

const scopedContext = {
	...context,
	resourceScope: {
		kind: "category" as const,
		categoryId: "11111111-1111-4111-8111-111111111111",
		permissions: ["read", "edit", "read"] as const,
	},
};

const verifyOptions = {
	secret: "secret",
	issuer: context.issuer,
	nowSeconds: context.issuedAt + 10,
};

async function rejectionMessage(operation: () => Promise<unknown>) {
	try {
		await operation();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe("workspace context assertions", () => {
	test("verifies a signed assertion and preserves its typed context", async () => {
		const assertion = await createDocsmintWorkspaceAssertion(context, "secret");
		expect(
			await verifyDocsmintWorkspaceAssertion(assertion, {
				secret: "secret",
				issuer: "docs-mint",
				nowSeconds: context.issuedAt + 10,
			}),
		).toEqual(context);
	});

	test("matches SDK values for legacy and category-scoped assertions", async () => {
		for (const fixture of [context, scopedContext]) {
			const sdkAssertion = await createSdkAssertion(fixture as never, "secret");
			const backendAssertion = await createDocsmintWorkspaceAssertion(
				fixture as never,
				"secret",
			);
			expect(backendAssertion).toBe(sdkAssertion);
			const [sdkValue, backendValue] = await Promise.all([
				verifySdkAssertion(sdkAssertion, verifyOptions),
				verifyDocsmintWorkspaceAssertion(backendAssertion, verifyOptions),
			]);
			expect(backendValue).toEqual(sdkValue);
			if ("resourceScope" in fixture) {
				expect(Object.isFrozen(backendValue.resourceScope)).toBe(true);
				expect(Object.isFrozen(backendValue.resourceScope?.permissions)).toBe(
					true,
				);
			}
		}
	});

	test("matches SDK validation errors for every restricted-scope boundary", async () => {
		const fixtures = [
			{ ...context, unexpected: true },
			{
				...scopedContext,
				resourceScope: { ...scopedContext.resourceScope, unexpected: true },
			},
			{
				...scopedContext,
				resourceScope: {
					...scopedContext.resourceScope,
					kind: "folder",
				},
			},
			{
				...scopedContext,
				resourceScope: {
					...scopedContext.resourceScope,
					categoryId: "invalid",
				},
			},
			{
				...scopedContext,
				resourceScope: {
					...scopedContext.resourceScope,
					permissions: ["read", "delete"],
				},
			},
		] as const;
		for (const fixture of fixtures) {
			const [sdkError, backendError] = await Promise.all([
				rejectionMessage(() => createSdkAssertion(fixture as never, "secret")),
				rejectionMessage(() =>
					createDocsmintWorkspaceAssertion(fixture as never, "secret"),
				),
			]);
			expect(backendError).toBe(sdkError);
			expect(backendError).not.toBeNull();
		}

		const expired = await createSdkAssertion(
			{
				...context,
				issuedAt: context.issuedAt - 120,
				expiresAt: context.issuedAt - 60,
			},
			"secret",
		);
		const [sdkExpiry, backendExpiry] = await Promise.all([
			rejectionMessage(() => verifySdkAssertion(expired, verifyOptions)),
			rejectionMessage(() =>
				verifyDocsmintWorkspaceAssertion(expired, verifyOptions),
			),
		]);
		expect(backendExpiry).toBe(sdkExpiry);
		expect(backendExpiry).toBe("Workspace assertion is expired");
	});

	test("carries only the verified signed resource scope into tenant context", async () => {
		const previous = {
			enabled: config.DOCSMINT_WORKSPACE_ENABLED,
			secret: config.DOCSMINT_WORKSPACE_SECRET,
			issuer: config.DOCSMINT_WORKSPACE_ISSUER,
		};
		Object.assign(config, {
			DOCSMINT_WORKSPACE_ENABLED: true,
			DOCSMINT_WORKSPACE_SECRET: "secret",
			DOCSMINT_WORKSPACE_ISSUER: context.issuer,
		});
		try {
			const nowSeconds = Math.floor(Date.now() / 1000);
			const assertion = await createDocsmintWorkspaceAssertion(
				{
					...scopedContext,
					issuedAt: nowSeconds,
					expiresAt: nowSeconds + 60,
				} as never,
				"secret",
			);
			const tenant = await buildTenantContext(
				new Request("https://docs.example/api/documents", {
					headers: { "x-docsmint-workspace-context": assertion },
				}),
			);
			expect(tenant.resourceScope).toEqual(scopedContext.resourceScope);
			expect(Object.isFrozen(tenant.resourceScope)).toBe(true);
		} finally {
			Object.assign(config, {
				DOCSMINT_WORKSPACE_ENABLED: previous.enabled,
				DOCSMINT_WORKSPACE_SECRET: previous.secret,
				DOCSMINT_WORKSPACE_ISSUER: previous.issuer,
			});
		}
	});

	test("rejects tampering, expiry, and an unexpected issuer", async () => {
		const assertion = await createDocsmintWorkspaceAssertion(context, "secret");
		await expect(
			verifyDocsmintWorkspaceAssertion(assertion, {
				secret: "wrong",
				issuer: "docs-mint",
				nowSeconds: context.issuedAt + 10,
			}),
		).rejects.toThrow("signature");
		await expect(
			verifyDocsmintWorkspaceAssertion(assertion, {
				secret: "secret",
				issuer: "docs-mint",
				nowSeconds: context.expiresAt + 6,
			}),
		).rejects.toThrow("expired");
		await expect(
			verifyDocsmintWorkspaceAssertion(assertion, {
				secret: "secret",
				issuer: "other-host",
				nowSeconds: context.issuedAt + 10,
			}),
		).rejects.toThrow("issuer");
	});

	test("rejects an assertion without a workspace id", async () => {
		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, workspaceId: "" },
				"secret",
			),
		).rejects.toThrow("workspaceId");
	});

	test("rejects a non-UUID actor, oversized workspace, and TTL above sixty seconds", async () => {
		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, actorUserId: "user-1" },
				"secret",
			),
		).rejects.toThrow("actorUserId");
		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, workspaceId: "w".repeat(129) },
				"secret",
			),
		).rejects.toThrow("workspaceId");
		await expect(
			createDocsmintWorkspaceAssertion(
				{ ...context, expiresAt: context.issuedAt + 61 },
				"secret",
			),
		).rejects.toThrow("maximum TTL");
	});
});
