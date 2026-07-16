import { folders } from "@hiai-docs/db/schema";
import { type AnyColumn, and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { buildTenantContext } from "../api/middleware/tenant";
import type { ApiKeyScope, CategoryApiPermission } from "./api-keys";
import { type AuthPrincipal, resolveAuthPrincipal } from "./auth-principal";
import {
	DOCSMINT_WORKSPACE_CONTEXT_HEADER,
	EXTERNAL_TENANT_CONTEXT_HEADER,
	ExternalTenantContextError,
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
	if (
		request.headers.has(DOCSMINT_WORKSPACE_CONTEXT_HEADER) ||
		request.headers.has(EXTERNAL_TENANT_CONTEXT_HEADER)
	) {
		const ctx = await buildTenantContext(request);
		if (ctx.source !== "external" || !ctx.workspaceId) {
			throw new ExternalTenantContextError("Invalid external tenant context");
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
	const permissions = new Set<CategoryApiPermission>(["read"]);
	if (ctx.actorRole === "owner" || ctx.actorRole === "admin") {
		permissions.add("edit");
		permissions.add("write");
	} else if (ctx.actorRole === "editor") {
		permissions.add("edit");
	}
	return {
		principal: { kind: "session", userId: ctx.userId },
		ctx,
		userId: ctx.userId,
		categoryId: null,
		permissions,
		restricted: true,
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
	if (access.externalRole) return true;
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
	ownerId: string,
	folderId: string,
): Promise<string | null | undefined> {
	const rows = (await tx.execute(
		sql`
			WITH RECURSIVE ancestors AS (
				SELECT ${folders.id} AS id, ${folders.parentId} AS parent_id,
					${folders.categoryId} AS category_id
				FROM ${folders}
				WHERE ${folders.id} = ${folderId} AND ${folders.ownerId} = ${ownerId}
				UNION ALL
				SELECT f.id, f.parent_id, f.category_id
				FROM folders f JOIN ancestors a ON f.id = a.parent_id
				WHERE f.owner_id = ${ownerId}
			)
			SELECT category_id FROM ancestors WHERE category_id IS NOT NULL LIMIT 1
		`,
	)) as Array<{ category_id: string }>;
	// undefined distinguishes a missing/unowned folder from an uncategorized one.
	if (rows.length === 0) {
		const exists = (await tx.execute(
			sql`SELECT 1 FROM ${folders} WHERE ${folders.id} = ${folderId} AND ${folders.ownerId} = ${ownerId}`,
		)) as unknown[];
		return exists.length > 0 ? null : undefined;
	}
	return rows[0]?.category_id ?? null;
}
