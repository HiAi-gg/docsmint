# Document image WebP normalization

Set `DOCSMINT_ATTACHMENT_WEBP_ENABLED=true` in the backend to normalize new
document image uploads. The default is false. Existing attachment UUIDs and
raw URLs continue to resolve their stored content types.

PNG is encoded losslessly, JPEG uses WebP quality 85 after orientation,
GIF retains animation, and a validated WebP retains its bytes. Processing
permits at most two concurrent encodes per backend process, 40 million
decoded pixels across all frames and 120 frames.

Presigned uploads use a temporary `.webp.pending` source key. Confirmation
creates a separate permanent `.webp` object. Clients use the confirmed
attachment UUID and returned filename, MIME type and size. Read bytes through
the existing authenticated raw endpoint. A presigned PUT never targets the
permanent object.

Confirmation uses the permanent object key for quota accounting. Successful
confirmation queues source cleanup through the existing worker, retaining
cleanup authority through the original PUT expiry. Temporary storage failures
return 503 and Retry-After. Repeat confirmation with the same upload token,
source key and original source metadata. A completed confirmation returns the
existing attachment UUID without another PUT.

A WebP presign request may include optional `sourceSha256`, the lowercase
SHA-256 of the original bytes. The signed upload token binds this digest.
Confirmation recomputes it from the bytes read from storage before conversion
and rejects a mismatch before writing the permanent object. This field verifies
source integrity.

Supply an optional `Idempotency-Key` header with `sourceSha256` for durable
upload retries. Keys use 1–128 characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` and are scoped to actor, workspace and
document. Identical retries reuse the source key and signed admission.
Different bytes or metadata return 409. An active lease returns 409 with
Retry-After. An expired or removed admission returns 410; start an explicitly
new operation. A confirmed replay returns `alreadyConfirmed: true`, an empty
`url`, and the original key/token. Skip PUT and repeat confirm to recover the
attachment receipt. Authorization is rechecked on every retry.
The operation journal and initial admission are committed together.
The journal is removed by document/account deletion, not by upload cleanup.

MCP `upload_document_image` exposes optional `operationId` for this header and
computes the source digest itself. Reuse that value after connection loss.
MCP `check_document_attachments` reads the complete authorized response with
a 30-second timeout and a 16-MiB verification limit, checks MIME/signature and
recorded size, and returns `verification: { size, mimeType, sha256 }`.
This digest describes downloaded stored bytes. It does not claim that the
image is visually correct or replace decoding validation during upload.

Upload and confirmation do not edit document Markdown or publish content.
Insert the returned raw reference through a separate authorized document save.

See [Skills automation guide](skills-image-automation.md) for stable operation IDs, batch rules and the authenticated Cloud retrieval contract.

## Verified so far

- Real-byte PNG alpha, JPEG orientation, GIF frames/timing, malformed input,
  frame limits and concurrent encode limits pass.
- HTTP fixture: ten uploads, authenticated WebP readback, repeated confirmations
  and a temporary PUT failure followed by successful confirmation pass.
- Existing isolated PostgreSQL: seven concurrency and lifecycle cases pass with
  the backend connected as hiai_app (neither superuser nor BYPASSRLS), including
  confirmation leases protecting both source and derived WebP objects.
  Two older workspace fixtures are excluded because they use non-UUID workspace
  IDs that conflict with the Cloud test database's workspace dependency triggers.
- Existing isolated SeaweedFS: ten synthetic PNG sources converted to WebP,
  MIME and sizes verified by GET, decoded pixels compared. All twenty created
  objects were deleted and HEAD returned 404 after cleanup.

- Upload operation journal: actual PostgreSQL concurrency and RLS pass as
  hiai_app without superuser/BYPASSRLS. Three concurrent retries share one ID;
  another actor/workspace cannot read or forge the journal.
- HTTP fixture: lost presign/confirm responses and changed-metadata conflicts
  pass for ten images without duplicate admissions or attachments.
- MCP: complete-stream verification rejects truncation, stream errors,
  oversized output, mismatched headers and non-image signatures.

- Real QA raw-attachment route with category/read keys: authorized WebP bytes
  match storage, adjacent category and foreign owner return 404, write is
  denied, revoked key returns 401. Uses synthetic personal-category fixtures,
  not the actual Skills workspace bindings.

Actual Skills workspace bindings, quota accounting through the full Cloud
confirmation route and Cloud production acceptance remain pending. Do not treat the component checks as release acceptance.
