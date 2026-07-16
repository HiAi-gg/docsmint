# Docsmint SaaS integration

Docsmint is a self-hosted, personal knowledge base by default. A SaaS host may add a shared workspace corpus only by sending a short-lived, server-generated `X-Docsmint-Workspace-Context` assertion. The SaaS host owns workspace records, membership, invitations, billing, entitlements, and every workspace UI surface; Docsmint stores only the opaque `workspaceId` tenant boundary.

## Trusted assertion

The header is `base64url(JSON(payload)).base64url(HMAC-SHA256(payload, secret))`. The payload contains a UUID `actorUserId`, non-empty `workspaceId`, role (`owner`, `admin`, `editor`, or `viewer`), `issuer`, `issuedAt`, and `expiresAt`. Generate it on the SaaS server only. Docsmint validates issuer, signature, clock skew, and a maximum five-minute TTL. Invalid or conflicting canonical and legacy headers fail closed; they never fall back to a personal session.

```ts
const workspaceClient = client.withRequestContext({
  workspaceAssertion: signedAssertion,
});
```

The 0.3.x aliases `X-Hiai-Tenant-Context` and `externalTenantAssertion` remain accepted for migration. New integrations must use the Docsmint names.

## Capabilities

| Role | Read | Edit document content | Create, move, delete, share, admin |
| --- | --- | --- | --- |
| viewer | yes | no | no |
| editor | yes | yes | no |
| admin | yes | yes | yes |
| owner | yes | yes | yes |

Docsmint route authorization enforces this matrix. PostgreSQL RLS is the tenant-isolation boundary, not a membership system.

## Shared-document extensions

Register `sharedDocumentHeaderActions`, `sharedDocumentTabs`, `sharedDocumentNotesModes`, and `sharedDocumentEditorModes` on `DocsmintExtensionProvider`. Each receives a safe `SharedDocumentExtensionContext`; it never contains a password, owner credentials, workspace assertion, or signing secret. Notes and editor modes are UI extension points only: base Docsmint does not provide share-token comment or edit mutation endpoints.

Use `DocsmintSharedDocumentHost` for host-owned shared route composition. Duplicate IDs are resolved deterministically, visibility failures hide only the faulty extension, and editor modes are rendered only when `permissions.edit` is true.
