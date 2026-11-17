# Skills image automation with DocsMint MCP

## Capability audit

Use the existing tools, not a separate media service.

| Action | Input | Evidence in response |
| --- | --- | --- |
| upload_document_image | documentId, filename, mimeType, contentBase64, operationId | attachment id, documentId, final filename/MIME/size, same-origin raw URL |
| check_document_attachments | documentId and optional attachmentId | document-bound items; verifiedAttachmentId and verification.size/mimeType/sha256 after full read |
| save_document | explicit authorized document revision | separate editorial change; upload/check never edit Markdown or publish |

PNG, JPEG and WebP sources are supported, at most 2 MiB before base64.
Use plain canonical base64 without a data URL prefix. A MIME signature mismatch
returns IMAGE_MIME_MISMATCH (415); a decoded oversized file returns
IMAGE_TOO_LARGE (413). Schema violations use MCP invalid-argument diagnostics.
Server decoding still validates complete image data, dimensions and frame limits.

With WebP finalization enabled, new images are stored and returned as WebP.
Use the returned MIME, filename and byte size, not the original PNG/JPEG values.
Existing attachment IDs and existing PNG/JPEG raw URLs remain supported.
GIF animation is preserved by REST conversion, while the MCP source schema
continues to accept only PNG, JPEG and WebP.

## Stable identities and retries

Persist one operationId per intended asset, scoped to its account, workspace
and document. For example: skills-human-article-123-hero-v1.
Reuse the operationId and identical bytes/filename/MIME after a timeout.
The client calculates sourceSha256 itself. The server checks actual source
bytes before conversion. A caller-supplied checksum alone proves nothing.

A completed replay skips PUT and recovers the original attachment receipt.
409 for a busy operation is retryable after Retry-After; 409 for changed input
requires investigation and an explicitly new asset revision.
410 means that an incomplete operation expired or was removed. Check the
document attachment list and the automation journal before starting a new ID.
Retain attachmentId after success and use it for all future reads.

Use sequential batches of up to ten images. Do not flood the two-slot
per-process converter. Each image has its own operationId and result.
Stop the batch on 401/403, storage quota exhaustion or a systemic failure.
For 429 and transient 503 honor Retry-After, then bounded exponential backoff
with jitter. Preserve unfinished operation IDs for the next run.
MCP upload and readback use finite 30-second deadlines.

## Readback before editing

1. Upload to the intended editable document.
2. Check the returned attachmentId against the same documentId.
3. Require complete readback, matching stored size and MIME, and record the
   returned SHA-256 of stored bytes.
4. Review the image and prepare approved alt text.
5. Save the intended Markdown revision as a separate authorized action.
6. Re-read the document and verify the reference. Publication remains a
   separate Skills approval action.

The byte checksum verifies complete transfer, not visual quality or editorial
approval. Never insert prompts, production notes, base64 or internal metadata.
Keep both the original source digest and the final stored-byte digest when
they differ after conversion.

Safe synthetic example:

upload_document_image({
  documentId: "<synthetic-document-uuid>",
  filename: "example.png",
  mimeType: "image/png",
  contentBase64: "<base64-of-generated-synthetic-image>",
  operationId: "synthetic-example-v1"
})

check_document_attachments({
  documentId: "<same-document-uuid>",
  attachmentId: "<returned-attachment-uuid>"
})

## Skills backend image proxy

Keep DocsMint keys on the Skills server. A category/read key must first read
the approved document and its attachment list, then fetch the exact returned
same-origin raw path with that key. Bind the proxy request to the approved
document and attachment IDs. Do not accept arbitrary remote URLs, forward
bearer keys to browsers, or turn DocsMint raw media anonymous.

Cloud's actual compatibility attachment paths are /api/documents/:id/attachments
and /api/attachments/:id/raw. Document reads may use Cloud /api/v1/documents/:id.
Do not invent a /api/v1/attachments alias. OSS uses its documented /api paths.
Verify the actual Skills workspace/category binding before enabling the proxy.

Only serve assets belonging to an approved document revision. Restrict any
cache to the configured approval and revocation policy; do not describe a
cached copy as a current DocsMint authorization check. Failed or revoked
upstream access must not create a newly public asset. Public rendering remains
the responsibility of Skills, including its security headers and cache policy.

## Failure journal and cleanup

Record documentId, operationId, attachmentId when known, stage, safe error code,
retry time, MIME, size and digest. Exclude tokens, presigned URLs, base64,
document text and search strings. Report each image as PASS, RETRY or FAIL.
A failed image does not justify rewriting a whole article.

Do not delete attachments referenced by documents or approved revisions.
Remove only known unreferenced test assets through authorized deletion.
Temporary source objects are handled by the existing upload cleanup worker.
Do not delete permanent WebP objects directly from storage.

## Acceptance evidence and limits

The Cloud candidate QA script scripts/qa/attachment-webp-live.test.ts exercises
ten real MCP uploads, replays and full digest readback through the OSS routes,
Cloud storage ledger, PostgreSQL runtime role and existing SeaweedFS.
It asserts one attachment per operation, unchanged Markdown and exact byte
accounting. Separate raw-route QA proves category/owner isolation, write
denial and 401 after key revocation. HTTP fixture tests cover temporary PUT
failure and same-admission recovery; MCP tests cover invalid MIME, oversize
and deleted attachments.

These checks do not prove that the actual Skills production key bindings or
its public proxy have been accepted. Run that restricted Cloud check and
record its environment/version separately. Do not change Skills production
articles or restart its hourly task as part of the DocsMint release.
