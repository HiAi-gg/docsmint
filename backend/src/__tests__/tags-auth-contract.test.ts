import { describe, expect, test } from "bun:test";
import {
	canAccessContent,
	canManageWorkspaceTags,
	contentAccessForPrincipal,
} from "../lib/content-access";

const ownerId = "11111111-1111-4111-8111-111111111111";
const categoryId = "22222222-2222-4222-8222-222222222222";

describe("workspace tag authorization", () => {
	test("refuses workspace-wide tag mutations for category-scoped writers", () => {
		const access = contentAccessForPrincipal({
			kind: "api-key",
			userId: ownerId,
			keyId: "category-key",
			scopes: [`category:${categoryId}:write`],
		});
		expect(canManageWorkspaceTags(access)).toBe(false);
		expect(canAccessContent(access, "write")).toBe(true);
	});

	test("allows document tag attach for category edit without collection rights", () => {
		const access = contentAccessForPrincipal({
			kind: "api-key",
			userId: ownerId,
			keyId: "category-key",
			scopes: [`category:${categoryId}:edit`],
		});
		expect(canAccessContent(access, "edit")).toBe(true);
		expect(canManageWorkspaceTags(access)).toBe(false);
	});

	test("allows unrestricted writers to manage the tag collection", () => {
		const access = contentAccessForPrincipal({
			kind: "api-key",
			userId: ownerId,
			keyId: "global-key",
			scopes: ["global"],
		});
		expect(canManageWorkspaceTags(access)).toBe(true);
	});
});
