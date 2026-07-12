import { describe, expect, test } from "bun:test";
import type { AuthPrincipal } from "../lib/auth-principal";
import {
	canAccessContent,
	contentAccessForPrincipal,
	effectiveDocumentCategory,
	isAuthorizedCategory,
} from "../lib/content-access";

const ownerId = "11111111-1111-4111-8111-111111111111";
const categoryId = "22222222-2222-4222-8222-222222222222";
const otherCategoryId = "33333333-3333-4333-8333-333333333333";

describe("content API authorization matrix", () => {
	test.each([
		"session",
		"operator",
		"global",
	] as const)("%s principal has owner-content access", (kind) => {
		const principal: AuthPrincipal =
			kind === "session"
				? ({ kind, userId: ownerId } as const)
				: kind === "operator"
					? ({ kind, userId: ownerId } as const)
					: {
							kind: "api-key",
							userId: ownerId,
							keyId: "global-key",
							scopes: ["global"],
						};
		const access = contentAccessForPrincipal(principal);
		expect(access.restricted).toBe(false);
		expect(canAccessContent(access, "read")).toBe(true);
		expect(canAccessContent(access, "edit")).toBe(true);
		expect(canAccessContent(access, "write")).toBe(true);
		expect(isAuthorizedCategory(access, otherCategoryId)).toBe(true);
	});

	test.each([
		["read", true, false, false],
		["edit", false, true, false],
		["write", false, false, true],
	] as const)("category %s scope is not implicitly broadened", (scope, read, edit, write) => {
		const access = contentAccessForPrincipal({
			kind: "api-key",
			userId: ownerId,
			keyId: `${scope}-key`,
			scopes: [`category:${categoryId}:${scope}`],
		});
		expect(access.restricted).toBe(true);
		expect(access.categoryId).toBe(categoryId);
		expect(canAccessContent(access, "read")).toBe(read);
		expect(canAccessContent(access, "edit")).toBe(edit);
		expect(canAccessContent(access, "write")).toBe(write);
		expect(isAuthorizedCategory(access, categoryId)).toBe(true);
		expect(isAuthorizedCategory(access, otherCategoryId)).toBe(false);
		expect(isAuthorizedCategory(access, null)).toBe(false);
	});

	test("combined category scopes preserve the explicit permission set", () => {
		const access = contentAccessForPrincipal({
			kind: "api-key",
			userId: ownerId,
			keyId: "combined-key",
			scopes: [`category:${categoryId}:read`, `category:${categoryId}:edit`],
		});
		expect(canAccessContent(access, "read")).toBe(true);
		expect(canAccessContent(access, "edit")).toBe(true);
		expect(canAccessContent(access, "write")).toBe(false);
	});

	test("document category prefers its explicit category and falls back to folder ancestry", () => {
		expect(
			effectiveDocumentCategory({
				categoryId,
				folderCategoryId: otherCategoryId,
			}),
		).toBe(categoryId);
		expect(
			effectiveDocumentCategory({
				categoryId: null,
				folderCategoryId: categoryId,
			}),
		).toBe(categoryId);
	});
});
