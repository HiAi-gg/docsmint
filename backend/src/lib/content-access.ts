import { folders } from "@hiai-docs/db/schema";
import { type AnyColumn, and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { buildTenantContext } from "../api/middleware/tenant";
import type { ApiKeyScope, CategoryApiPermission } from "./api-keys";
import { type AuthPrincipal, resolveAuthPrincipal } from "./auth-principal";
import {
	DOCSMINT_WORKSPACE_CONTEXT_HEADER,
	DocsmintWorkspaceContextError,
} from "./external-tenant-context";
import type { TenantContext } from "./with-tenant";
import { ZERO_UUID } from "./with-tenant";

export type ContentAction = "read" | "edit" | "write";

export type ContentAccess = {
	principal: AuthPrincipal | null;
	ctx: TenantContext;
	userId: string;
	categoryId: string | null;
	permissions: ReadonlySet<CategoryApiPermission>;
	restricted: boolean;
	externalRole?: "owner" | "admin" | "editor" | "viewer";
};

/**
 * Build an explicit owner/workspace predicate for route queries. RLS remains
 * the final enforcement layer, but this predicate prevents a route from
 * accidentally narrowing an external workspace request to the actor's
 * personal owner rows.
 */
export function tenantOwnerCondition(
	ownerColumn: AnyColumn,
	workspaceColumn: AnyColumn,
	ctx: TenantContext,
): SQL {
	if (ctx.source === "external" && ctx.workspaceId) {
		return eq(workspaceColumn, ctx.workspaceId);
	}
	return (
		and(isNull(workspaceColumn), eq(ownerColumn, ctx.userId)) ?? sql`false`
	);
}

/** SQL-template equivalent for the few recursive/raw retrieval queries. */
export function tenantOwnerSql(alias: string, ctx: TenantContext): SQL {
	const ownerColumn = sql.raw(`${alias}.owner_id`);
	const workspaceColumn = sql.raw(`${alias}.workspace_id`);
	if (ctx.source === "external" && ctx.workspaceId) {
		return sql`${workspaceColumn} = ${ctx.workspaceId}`;
	}
	return sql`${workspaceColumn} IS NULL AND ${ownerColumn} = ${ctx.userId}`;
}

function inheritedFolderCategorySql(
	folderId: AnyColumn | SQL,
	ctx: TenantContext,
): SQL {
	return sql`(
		WITH RECURSIVE ancestors AS (
			SELECT ancestor_folders.id, ancestor_folders.parent_id,
				ancestor_folders.category_id, 0 AS depth
			FROM folders ancestor_folders
			WHERE ancestor_folders.id = ${folderId}
				AND ${tenantOwnerSql("ancestor_folders", ctx)}
			UNION ALL
			SELECT parent.id, parent.parent_id, parent.category_id,
				ancestors.depth + 1
			FROM folders parent
			JOIN ancestors ON ancestors.parent_id = parent.id
			WHERE ${tenantOwnerSql("parent", ctx)}
		)
		SELECT ancestors.category_id
		FROM ancestors
		WHERE ancestors.category_id IS NOT NULL
		ORDER BY depth ASC
		LIMIT 1
	)`;
}

/** Raw-SQL equivalent for recursive queries that use explicit table aliases. */
export function effectiveDocumentCategorySql(
	documentAlias: string,
	ctx: TenantContext,
	categoryId: string | AnyColumn | SQL,
): SQL {
	return sql`coalesce(
		${sql.raw(`${documentAlias}.category_id`)},
		${inheritedFolderCategorySql(sql.raw(`${documentAlias}.folder_id`), ctx)}
	) = ${categoryId}`;
}

/** Raw-SQL equivalent for recursive folder queries with an explicit alias. */
export function effectiveFolderCategorySql(
	folderAlias: string,
	ctx: TenantContext,
	categoryId: string | AnyColumn | SQL,
): SQL {
	return sql`${inheritedFolderCategorySql(sql.raw(`${folderAlias}.id`), ctx)} = ${categoryId}`;
}

/** Effective direct-or-inherited category predicate for Drizzle document queries. */
export function effectiveDocumentCategoryCondition(
	documentCategory: AnyColumn,
	documentFolderId: AnyColumn,
	ctx: TenantContext,
	categoryId: string,
): SQL {
	return sql`coalesce(${documentCategory}, ${inheritedFolderCategorySql(documentFolderId, ctx)}) = ${categoryId}`;
}

/** Effective category predicate for a category root folder or any descendant. */
export function effectiveFolderCategoryCondition(
	folderId: AnyColumn,
	ctx: TenantContext,
	categoryId: string,
): SQL {
	return sql`${inheritedFolderCategorySql(folderId, ctx)} = ${categoryId}`;
}

function categoryGrant(scopes: readonly ApiKeyScope[]): {
	categoryId: string;
	permissions: Set<CategoryApiPermission>;
} | null {
	let categoryId: string | null = null;
	const permissions = new Set<CategoryApiPermission>();
	for (const scope of scopes) {
		const match = /^category:([^:]+):(read|edit|write)$/.exec(scope);
		if (!match?.[1] || !match[2]) continue;
		if (categoryId && categoryId !== match[1]) return null;
		categoryId = match[1];
		permissions.add(match[2] as CategoryApiPermission);
	}
	return categoryId ? { categoryId, permissions } : null;
}

/** Resolve content authorization without collapsing scoped API keys into sessions. */
export async function resolveContentAccess(
	request: Request,
): Promise<ContentAccess> {
	if (request.headers.has(DOCSMINT_WORKSPACE_CONTEXT_HEADER)) {
		const ctx = await buildTenantContext(request);
		if (ctx.source !== "external" || !ctx.workspaceId) {
			throw new DocsmintWorkspaceContextError("Invalid workspace context");
		}
		return contentAccessForExternalContext({
			...ctx,
			source: "external",
			workspaceId: ctx.workspaceId,
			actorRole: ctx.actorRole ?? "viewer",
		});
	}
	const principal = await resolveAuthPrincipal(request.headers);
	return contentAccessForPrincipal(principal);
}

export function contentAccessForExternalContext(
	ctx: TenantContext & {
		source: "external";
		workspaceId: string;
		actorRole: "owner" | "admin" | "editor" | "viewer";
	},
): ContentAccess {
	if (ctx.resourceScope) {
		return {
			principal: { kind: "session", userId: ctx.userId },
			ctx,
			userId: ctx.userId,
			categoryId: ctx.resourceScope.categoryId,
			permissions: new Set<CategoryApiPermission>(
				ctx.resourceScope.permissions,
			),
			restricted: true,
			externalRole: ctx.actorRole,
		};
	}
	const permissions = new Set<CategoryApiPermission>(["read"]);
	if (ctx.actorRole === "owner" || ctx.actorRole === "admin") {
		permissions.add("edit");
		permissions.add("write");
	} else if (ctx.actorRole === "editor") {
		permissions.add("edit");
		permissions.add("write");
	}
	return {
		principal: { kind: "session", userId: ctx.userId },
		ctx,
		userId: ctx.userId,
		categoryId: null,
		permissions,
		// An unscoped assertion remains workspace-wide. Only a signed resource
		// scope or an existing category API key sets `restricted`.
		restricted: false,
		externalRole: ctx.actorRole,
	};
}

/** Pure constructor used by route policy tests and non-HTTP adapters. */
export function contentAccessForPrincipal(
	principal: AuthPrincipal | null,
): ContentAccess {
	if (!principal) {
		return {
			principal: null,
			ctx: { userId: ZERO_UUID, role: "none" },
			userId: ZERO_UUID,
			categoryId: null,
			permissions: new Set(),
			restricted: false,
		};
	}
	if (principal.kind !== "api-key" || principal.scopes.includes("global")) {
		return {
			principal,
			ctx: {
				userId: principal.userId,
				role: principal.kind === "operator" ? "admin" : "user",
			},
			userId: principal.userId,
			categoryId: null,
			permissions: new Set(["read", "edit", "write"]),
			restricted: false,
		};
	}
	const grant = categoryGrant(principal.scopes);
	return {
		principal,
		ctx: { userId: principal.userId, role: "user" },
		userId: principal.userId,
		categoryId: grant?.categoryId ?? null,
		permissions: grant?.permissions ?? new Set(),
		restricted: true,
	};
}

export function canAccessContent(
	access: ContentAccess,
	action: ContentAction,
): boolean {
	if (access.externalRole) return access.permissions.has(action);
	return !access.restricted || access.permissions.has(action);
}

/** Category collection mutations require a full tenant writer, never a category key. */
export function canManageCategories(access: ContentAccess): boolean {
	return !access.restricted && canAccessContent(access, "write");
}

export function effectiveDocumentCategory(row: {
	categoryId: string | null;
	folderCategoryId?: string | null;
}): string | null {
	return row.categoryId ?? row.folderCategoryId ?? null;
}

export function isAuthorizedCategory(
	access: ContentAccess,
	categoryId: string | null,
): boolean {
	if (access.externalRole && !access.restricted) return true;
	return (
		!access.restricted || (!!categoryId && categoryId === access.categoryId)
	);
}

type QueryExecutor = {
	execute(query: SQL): Promise<unknown>;
};

/** Resolve the category inherited by a folder through its root ancestor. */
export async function resolveFolderEffectiveCategory(
	tx: QueryExecutor,
	ctx: TenantContext,
	folderId: string,
): Promise<string | null | undefined> {
	const rows = (await tx.execute(
		sql`
			WITH RECURSIVE ancestors AS (
				SELECT ${folders.id} AS id, ${folders.parentId} AS parent_id,
					${folders.categoryId} AS category_id
				FROM ${folders}
				WHERE ${folders.id} = ${folderId} AND ${tenantOwnerSql("folders", ctx)}
				UNION ALL
				SELECT f.id, f.parent_id, f.category_id
				FROM folders f JOIN ancestors a ON f.id = a.parent_id
				WHERE ${tenantOwnerSql("f", ctx)}
			)
			SELECT category_id FROM ancestors WHERE category_id IS NOT NULL LIMIT 1
		`,
	)) as Array<{ category_id: string }>;
	// undefined distinguishes a missing/unowned folder from an uncategorized one.
	if (rows.length === 0) {
		const exists = (await tx.execute(
			sql`SELECT 1 FROM ${folders} WHERE ${folders.id} = ${folderId} AND ${tenantOwnerSql("folders", ctx)}`,
		)) as unknown[];
		return exists.length > 0 ? null : undefined;
	}
	return rows[0]?.category_id ?? null;
}
