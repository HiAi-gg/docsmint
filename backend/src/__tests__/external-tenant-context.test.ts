import { describe, expect, test } from "bun:test";
import {
	createDocsmintWorkspaceAssertion,
	verifyDocsmintWorkspaceAssertion,
} from "../lib/external-tenant-context";

const context = {
	actorUserId: "00000000-0000-4000-8000-000000000001",
	workspaceId: "workspace-1",
	actorRole: "editor" as const,
	issuedAt: 1_700_000_000,
	expiresAt: 1_700_000_060,
	issuer: "docs-mint",
};

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
		).resolves.toBeString();
		const longAssertion = await createDocsmintWorkspaceAssertion(
			{ ...context, expiresAt: context.issuedAt + 61 },
			"secret",
		);
		await expect(
			verifyDocsmintWorkspaceAssertion(longAssertion, {
				secret: "secret",
				issuer: context.issuer,
				nowSeconds: context.issuedAt + 1,
			}),
		).rejects.toThrow("maximum TTL");
	});
});
