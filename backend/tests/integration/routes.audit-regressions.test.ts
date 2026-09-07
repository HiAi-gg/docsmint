import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import type { AuthPrincipal } from "../../src/lib/auth-principal";
import {
	getState,
	OWNER_ID,
	ownerHeaders,
	request,
	resetState,
	setupHarness,
} from "./_harness";

let principal: AuthPrincipal = { kind: "session", userId: OWNER_ID };
mock.module("../../src/lib/auth-principal", () => ({
	resolveAuthPrincipal: async () => principal,
	resolveBrowserSessionUserId: async () => OWNER_ID,
}));

const workspaceValues: unknown[] = [];
let app: Awaited<ReturnType<typeof setupHarness>>["app"];
beforeAll(async () => {
	const { db } = await import("../../src/lib/db");
	const execute = db.execute.bind(db);
	spyOn(db, "execute").mockImplementation(((
		query: Parameters<typeof db.execute>[0],
	) => {
		const captured = query as unknown as {
			strings?: string[];
			values?: unknown[];
		};
		if (captured.strings?.join(" ").includes("app.current_workspace_id")) {
			workspaceValues.push(captured.values?.[0]);
		}
		return execute(query);
	}) as typeof db.execute);
	app = (await setupHarness()).app;
});
beforeEach(() => {
	resetState();
	workspaceValues.length = 0;
	principal = { kind: "session", userId: OWNER_ID };
});

describe("tag collection authorization", () => {
	for (const method of ["POST", "PATCH", "DELETE"]) {
		test(`${method} rejects a category read key before mutating tags`, async () => {
			principal = {
				kind: "api-key",
				userId: OWNER_ID,
				keyId: "key",
				scopes: ["category:11111111-1111-4111-8111-111111111111:read"],
			};
			getState().tags.set("tag", {
				id: "tag",
				ownerId: OWNER_ID,
				name: "Original",
			});
			const response = await request(
				app,
				method === "POST" ? "/api/tags" : "/api/tags/tag",
				{
					method,
					headers: ownerHeaders(),
					...(method !== "DELETE"
						? { body: JSON.stringify({ name: "Changed" }) }
						: {}),
				},
			);
			expect(response.status).toBe(403);
			expect(getState().tags.get("tag")?.name).toBe("Original");
			expect(getState().tags.size).toBe(1);
		});
	}
});

describe("workspace viewer tag authorization", () => {
	for (const method of ["POST", "PATCH", "DELETE"]) {
		test(`${method} rejects a signed viewer assertion`, async () => {
			const { config } = await import("../../src/lib/config");
			Object.assign(config, {
				DOCSMINT_WORKSPACE_ENABLED: true,
				DOCSMINT_WORKSPACE_SECRET: "test-workspace-signing-secret",
				DOCSMINT_WORKSPACE_ISSUER: "test-host",
				DOCSMINT_WORKSPACE_CLOCK_SKEW_SECONDS: 0,
			});
			const { createDocsmintWorkspaceAssertion } = await import(
				"../../src/lib/external-tenant-context"
			);
			const now = Math.floor(Date.now() / 1000);
			const assertion = await createDocsmintWorkspaceAssertion(
				{
					actorUserId: OWNER_ID,
					workspaceId: "workspace",
					actorRole: "viewer",
					issuer: "test-host",
					issuedAt: now,
					expiresAt: now + 60,
				},
				"test-workspace-signing-secret",
			);
			getState().tags.set("tag", {
				id: "tag",
				ownerId: OWNER_ID,
				workspaceId: "workspace",
				name: "Original",
			});
			const response = await request(
				app,
				method === "POST" ? "/api/tags" : "/api/tags/tag",
				{
					method,
					headers: ownerHeaders({ "x-docsmint-workspace-context": assertion }),
					...(method !== "DELETE"
						? { body: JSON.stringify({ name: "Changed" }) }
						: {}),
				},
			);
			expect(response.status).toBe(403);
			expect(getState().tags.get("tag")?.name).toBe("Original");
			expect(getState().tags.size).toBe(1);
		});
	}
});

describe("partial category API settings", () => {
	for (const [patch, expected] of [
		[
			{ apiPermissionEdit: true },
			{
				apiMode: "category",
				apiPermissionRead: true,
				apiPermissionEdit: true,
				apiPermissionWrite: true,
			},
		],
		[
			{ apiMode: "global" },
			{
				apiMode: "global",
				apiPermissionRead: true,
				apiPermissionEdit: false,
				apiPermissionWrite: true,
			},
		],
		[
			{ apiMode: "unavailable" },
			{
				apiMode: "unavailable",
				apiPermissionRead: false,
				apiPermissionEdit: false,
				apiPermissionWrite: false,
			},
		],
	] as const) {
		test(`preserves omitted fields for ${JSON.stringify(patch)}`, async () => {
			getState().categories.set("category", {
				id: "category",
				ownerId: OWNER_ID,
				name: "Category",
				apiMode: "category",
				apiPermissionRead: true,
				apiPermissionEdit: false,
				apiPermissionWrite: true,
			});
			const response = await request(app, "/api/categories/category", {
				method: "PATCH",
				headers: ownerHeaders(),
				body: JSON.stringify(patch),
			});
			expect(response.status).toBe(200);
			expect(response.body).toMatchObject(expected);
			expect(getState().calls).toContainEqual({
				kind: "lock:update",
				table: "categories",
				ids: ["category"],
			});
		});
	}
});

describe("public workspace shares", () => {
	for (const workspaceId of [null, "shared-workspace"]) {
		for (const suffix of ["", "/folders/folder", "/documents/document"]) {
			test(`uses persisted workspace ${workspaceId} for ${suffix || "root"}`, async () => {
				const now = new Date();
				getState().shareLinks.set("share", {
					id: "share",
					token: "token",
					createdBy: OWNER_ID,
					workspaceId,
					folderId: "folder",
					categoryId: null,
					documentId: null,
					passwordHash: null,
					expiresAt: null,
				});
				getState().folders.set("folder", {
					id: "folder",
					ownerId: OWNER_ID,
					workspaceId,
					name: "Folder",
					parentId: null,
					createdAt: now,
					updatedAt: now,
				});
				getState().documents.set("document", {
					id: "document",
					ownerId: OWNER_ID,
					workspaceId,
					folderId: "folder",
					title: "Document",
					content: "Content",
					createdAt: now,
					updatedAt: now,
				});
				const response = await request(app, `/api/share/token${suffix}`, {
					headers: { "x-docsmint-workspace-context": "untrusted-workspace" },
				});
				expect(response.status).toBe(200);
				expect(workspaceValues.length).toBeGreaterThan(1);
				for (const value of workspaceValues.slice(1)) {
					expect(value).toBe(workspaceId ?? "");
				}
			});
		}
	}
});
