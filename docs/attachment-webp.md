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
source integrity; durable request idempotency remains a separate requirement.

Upload and confirmation do not edit document Markdown or publish content.
Insert the returned raw reference through a separate authorized document save.

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

Category-key attachment isolation, quota accounting through the real confirmation route,
persistent idempotency across new upload requests and Cloud production
acceptance remain pending. Do not treat the component checks as release acceptance.
