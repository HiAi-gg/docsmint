import { describe, expect, test } from "bun:test";
import { buildApiAccessValues } from "../lib/category-api-access";
import {
	canAccessContent,
	canManageCategories,
	canManageWorkspaceTags,
	contentAccessForExternalContext,
	contentAccessForPrincipal,
	effectiveDocumentCategory,
	isAuthorizedCategory,
} from "../lib/content-access";
import {
	AttachmentQuotaError,
	isRetryableQuotaError,
} from "../lib/runtime-options";

const ownerId = "11111111-1111-4111-8111-111111111111";
const categoryId = "22222222-2222-4222-8222-222222222222";
const otherCategoryId = "33333333-3333-4333-8333-333333333333";

function categoryKey(permission: "read" | "edit" | "write") {
	return contentAccessForPrincipal({
		kind: "api-key",
		userId: ownerId,
		keyId: `${permission}-key`,
		scopes: [`category:${categoryId}:${permission}`],
	});
}

function canMutateAttachment(
	access: ReturnType<typeof contentAccessForPrincipal>,
	document: {
		categoryId: string | null;
		folderCategoryId?: string | null;
	},
): boolean {
	if (!canAccessContent(access, "edit")) return false;
	if (!access.restricted) return true;
	return isAuthorizedCategory(access, effectiveDocumentCategory(document));
}

describe("0.8.3 editing and access regression", () => {
	test("category-scoped keys retain category identity and cannot manage workspace collections", () => {
		const access = categoryKey("write");
		expect(access.categoryId).toBe(categoryId);
		expect(access.restricted).toBe(true);
		expect(canAccessContent(access, "write")).toBe(true);
		expect(isAuthorizedCategory(access, categoryId)).toBe(true);
		expect(isAuthorizedCategory(access, otherCategoryId)).toBe(false);
		expect(canManageCategories(access)).toBe(false);
		expect(canManageWorkspaceTags(access)).toBe(false);
	});

	test("viewers and category keys are refused workspace tag mutations", () => {
		const viewer = contentAccessForExternalContext({
			userId: ownerId,
			workspaceId: "workspace-a",
			source: "external",
			role: "user",
			actorRole: "viewer",
		});
		const writer = contentAccessForPrincipal({
			kind: "api-key",
			userId: ownerId,
			keyId: "global-key",
			scopes: ["global"],
		});
		expect(canManageWorkspaceTags(viewer)).toBe(false);
		expect(canManageWorkspaceTags(categoryKey("write"))).toBe(false);
		expect(canManageWorkspaceTags(writer)).toBe(true);
	});

	test("partial category PATCH merge keeps omitted API settings", () => {
		const existing = {
			apiMode: "category",
			apiPermissionRead: true,
			apiPermissionEdit: false,
			apiPermissionWrite: true,
		};
		expect(
			buildApiAccessValues({
				existing,
				apiPermissionWrite: false,
			}),
		).toEqual({
			apiMode: "category",
			apiPermissionRead: true,
			apiPermissionEdit: false,
			apiPermissionWrite: false,
		});
	});

	test("attachment edits require edit scope on the document category", () => {
		const inCategory = { categoryId, folderCategoryId: null };
		const inherited = {
			categoryId: null,
			folderCategoryId: categoryId,
		};
		const other = { categoryId: otherCategoryId, folderCategoryId: null };
		expect(canMutateAttachment(categoryKey("write"), inCategory)).toBe(false);
		expect(canMutateAttachment(categoryKey("edit"), inCategory)).toBe(true);
		expect(canMutateAttachment(categoryKey("edit"), inherited)).toBe(true);
		expect(canMutateAttachment(categoryKey("edit"), other)).toBe(false);
		expect(canMutateAttachment(categoryKey("read"), inCategory)).toBe(false);
	});

	test("quota failures keep retryable identity separate from terminal rejection", () => {
		expect(isRetryableQuotaError(new AttachmentQuotaError("busy", true))).toBe(
			true,
		);
		expect(
			isRetryableQuotaError(new AttachmentQuotaError("quota exceeded", false)),
		).toBe(false);
	});
});
