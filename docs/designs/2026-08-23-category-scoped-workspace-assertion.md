# Category-Scoped Workspace Assertion Design

## Goal

DocsMint OSS 0.7.0 extends the public, generic workspace assertion contract with an optional signed category resource scope. The change reuses the existing category-restricted content-access model and adds no host roles, invitations, billing, quotas, or product UI.

Unscoped assertions remain workspace-wide and preserve the 0.6.8 behavior.

## Public Contract

The SDK and backend expose the same additive types:

```ts
export type WorkspaceResourcePermission = "read" | "edit" | "write";

export type WorkspaceResourceScope = Readonly<{
	kind: "category";
	categoryId: string;
	permissions: readonly WorkspaceResourcePermission[];
}>;

export interface WorkspaceAssertionPayload {
	actorUserId: string;
	workspaceId: string;
	actorRole: WorkspaceRole;
	resourceScope?: WorkspaceResourceScope;
	issuer: string;
	issuedAt: number;
	expiresAt: number;
}
```

`DocsmintWorkspaceContext` remains an exported compatibility alias for the assertion payload. Existing create and verify function names remain unchanged and are re-exported from the package root and `./workspace` entrypoint.

## Validation and Signing

Creation validates the complete payload before signing. Verification authenticates the exact encoded payload before parsing and validating it.

Both paths enforce:

- the existing actor UUID, workspace ID, role, issuer, timestamp, TTL, and clock-skew rules;
- an exact top-level field set, with `resourceScope` as the only optional field;
- an exact resource-scope field set: `kind`, `categoryId`, and `permissions`;
- `kind === "category"`;
- a UUID category ID;
- an array containing only `read`, `edit`, or `write` values.

An empty permission array is valid and denies every content action. Duplicate valid permissions are harmless and collapse into the runtime permission set. Unknown fields or permission values are rejected. Mutating the category ID or permissions without re-signing fails signature verification.

Returned contexts and nested scope data are copied and frozen so callers cannot mutate verified authorization state.

## Access Resolution

The verified optional scope travels through the external `TenantContext`. `resolveContentAccess` converts it into the existing generic restricted access shape:

- `restricted: true`;
- `categoryId` from the signed scope;
- a permission set containing only the signed permissions;
- the verified workspace ID and actor identity remain the tenant boundary.

An assertion without `resourceScope` continues to derive workspace-wide permissions from `actorRole` and has `restricted: false`.

No category scope is inferred from unsigned headers, query parameters, sessions, or host state.

## Effective Category and Query Ordering

A document belongs to a category when either:

1. its direct `category_id` matches; or
2. it has no direct category and its folder inherits the category from an ancestor.

Shared access helpers provide equivalent Drizzle and raw-SQL predicates for effective-category checks. Restricted predicates are applied inside database queries before `COUNT`, `LIMIT`, or `OFFSET`. Post-pagination filtering is not an authorization mechanism.

The category scope covers:

- document lists, cursor lists, reads, writes, snapshots, versions, and visibility;
- category-root folders and every nested folder;
- tags only when they are related to at least one authorized, non-deleted document;
- lexical, vector, expanded, and GraphRAG search channels;
- graph seeds and returned graph documents;
- document index status and refresh operations.

All document seed IDs are authorized relationally before graph traversal. Graph results are authorized again before fusion or response serialization.

## Counts

Document-list totals use the same tenant, soft-delete, tag, folder, and effective-category predicates as the list query, but are computed before pagination.

Folder and category `documentCount` values include direct documents and documents in the complete descendant-folder subtree. Every count excludes rows where `deleted_at IS NOT NULL` and uses the workspace-aware tenant predicate rather than an owner-only condition.

## Permissions

Permissions remain independent and do not imply one another:

- read operations require `read`;
- content editing operations require their existing `edit` or `write` policy;
- `get_document_index_status` and `DocsClient.getDocumentIndexStatus()` require `read`;
- `refresh_document_index` and `DocsClient.refreshDocumentIndex()` require `write`.

Category collection management remains unavailable to restricted assertions unless a route explicitly represents content inside the signed category. The change does not create workspace administration capabilities.

## Compatibility

- Assertions produced by 0.6.8 without `resourceScope` verify and retain workspace-wide behavior.
- The assertion header, create/verify function names, role values, and 60-second lifetime remain unchanged.
- Existing category API keys continue to use the same `ContentAccess` enforcement.
- SDK index-status and refresh methods retain their names and request shapes.
- MCP retains exactly 17 tools, 2 prompts, and 3 resources.

## Testing

Focused tests cover strict creation and verification, signature tampering, expiry, UUID and permission rejection, and legacy unscoped assertions.

Route and database tests cover category isolation, inherited folders, soft-deleted rows, pre-pagination totals, tags, search, graph seeds/results, versions, snapshots, index permissions, and count correctness. Contract tests assert SDK exports and the complete MCP catalog.

Integration tests must exercise workspace assertions against PostgreSQL with no required skips in release CI.

## Release

The completed hardening work and this contract ship together as DocsMint OSS 0.7.0 from `main`.

The release synchronizes package manifests, Swagger/OpenAPI metadata, changelog, generated SDK declarations, and `server.json`. After all repository, database, package-consumer, Docker, browser, and compatibility gates pass, the authorized release operation pushes `main`, creates and pushes annotated tag `v0.7.0`, and waits for the existing GitHub workflow to publish npm, the official MCP Registry entry, container images, and the GitHub Release.

Post-release verification records the published npm version, official registry version, release commit SHA, and tag for the host team. No third-party catalog changes are required.
