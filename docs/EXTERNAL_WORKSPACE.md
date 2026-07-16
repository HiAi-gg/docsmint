# Docsmint workspace context

Docsmint can be mounted by a trusted host that owns workspace membership and
lifecycle. HiAi-Docs stores only an opaque `workspace_id`; it does not manage
workspaces, members, invitations, billing, or workspace UI.

## Configuration

Set `DOCSMINT_WORKSPACE_ENABLED=true`, `DOCSMINT_WORKSPACE_ISSUER`, and a private
`DOCSMINT_WORKSPACE_SECRET` in the API environment. The default is disabled, and
an assertion is rejected when the integration is not enabled. Personal
self-hosted requests continue to use the session-derived `owner_id` context.

## Assertion transport

The gateway sends one `X-Docsmint-Workspace-Context` header containing:

```text
base64url(JSON(ExternalTenantContext)).base64url(HMAC-SHA256(payload, secret))
```

The payload is:

```ts
interface DocsmintWorkspaceContext {
  actorUserId: string;
  workspaceId: string;
  actorRole: "owner" | "admin" | "editor" | "viewer";
  issuedAt: number;
  expiresAt: number;
  issuer: string;
}
```

Docsmint verifies the signature, issuer, five-minute maximum lifetime, role, UUID actor, and non-empty
workspace ID before creating a request context. A browser-supplied workspace
ID or unsigned header is never trusted. Invalid assertions fail closed rather
than falling back to personal context.

## SDK hook

Trusted hosts attach the assertion with the SDK request context:

```ts
const docs = new DocsClient({ baseUrl: "https://docs.internal" });
const workspaceDocs = docs.withRequestContext({
  workspaceAssertion: signedAssertion,
});
await workspaceDocs.listDocs();
```

The assertion should be short-lived and generated server-side. Do not put the
signing secret or assertion-generation code in browser bundles. During 0.3.x,
`X-Hiai-Tenant-Context`, `externalTenantAssertion`, and `EXTERNAL_TENANT_*`
remain deprecated compatibility aliases.
