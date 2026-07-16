import { describe, expect, test } from "bun:test";
import {
	createExternalTenantAssertion,
	verifyExternalTenantAssertion,
} from "../lib/external-tenant-context";

const context = {
	actorUserId: "00000000-0000-4000-8000-000000000001",
	workspaceId: "workspace-1",
	actorRole: "editor" as const,
	issuedAt: 1_700_000_000,
	expiresAt: 1_700_000_300,
	issuer: "docs-mint",
};

describe("external tenant context assertions", () => {
	test("verifies a signed assertion and preserves its typed context", async () => {
		const assertion = await createExternalTenantAssertion(context, "secret");
		expect(
			await verifyExternalTenantAssertion(assertion, {
				secret: "secret",
				issuer: "docs-mint",
				nowSeconds: context.issuedAt + 10,
			}),
		).toEqual(context);
	});

	test("rejects tampering, expiry, and an unexpected issuer", async () => {
		const assertion = await createExternalTenantAssertion(context, "secret");
		await expect(
			verifyExternalTenantAssertion(assertion, {
				secret: "wrong",
				issuer: "docs-mint",
				nowSeconds: context.issuedAt + 10,
			}),
		).rejects.toThrow("signature");
		await expect(
			verifyExternalTenantAssertion(assertion, {
				secret: "secret",
				issuer: "docs-mint",
				nowSeconds: context.expiresAt + 6,
			}),
		).rejects.toThrow("expired");
		await expect(
			verifyExternalTenantAssertion(assertion, {
				secret: "secret",
				issuer: "other-host",
				nowSeconds: context.issuedAt + 10,
			}),
		).rejects.toThrow("issuer");
	});

	test("rejects an assertion without a workspace id", async () => {
		await expect(
			createExternalTenantAssertion({ ...context, workspaceId: "" }, "secret"),
		).rejects.toThrow("workspaceId");
	});

	test("rejects a non-UUID actor, oversized workspace, and TTL above five minutes", async () => {
		await expect(
			createExternalTenantAssertion({ ...context, actorUserId: "user-1" }, "secret"),
		).rejects.toThrow("actorUserId");
		await expect(
			createExternalTenantAssertion({ ...context, workspaceId: "w".repeat(129) }, "secret"),
		).rejects.toThrow("workspaceId");
		await expect(
			createExternalTenantAssertion({ ...context, expiresAt: context.issuedAt + 301 }, "secret"),
		).resolves.toBeString();
		const longAssertion = await createExternalTenantAssertion(
			{ ...context, expiresAt: context.issuedAt + 301 },
			"secret",
		);
		await expect(
			verifyExternalTenantAssertion(longAssertion, {
				secret: "secret",
				issuer: context.issuer,
				nowSeconds: context.issuedAt + 1,
			}),
		).rejects.toThrow("maximum TTL");
	});
});
