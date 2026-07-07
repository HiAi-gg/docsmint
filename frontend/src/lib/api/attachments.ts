import { apiFetch } from "./client";

export interface Attachment {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
	url: string;
}

export interface AttachmentListResponse {
	items: Attachment[];
}

/**
 * Server-side attachment size limit (bytes). The backend reads this from
 * `ATTACHMENT_MAX_SIZE_MB` (default 25 MB); we hard-code the same default
 * here so the client UI rejects obviously-oversized files before they
 * even hit the network. Operators who change the env var SHOULD also
 * update this constant — they're intentionally separate to avoid a
 * runtime config dependency in the frontend bundle.
 */
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

interface PresignResponse {
	url: string;
	key: string;
	maxSize: number;
	expiresIn: number;
}

/**
 * Request a presigned PUT URL from the backend. The returned URL is
 * scoped to a single storage object and expires after `expiresIn` seconds.
 * No file bytes cross the wire in this call.
 */
export function presignAttachment(
	documentId: string,
	file: File,
): Promise<PresignResponse> {
	return apiFetch<PresignResponse>(
		`/api/documents/${documentId}/attachments/presign`,
		{
			method: "POST",
			body: {
				filename: file.name,
				contentType: file.type,
				size: file.size,
			},
		},
	);
}

/**
 * Tell the backend to record an attachment row for an object that has
 * already been PUT to storage. The backend verifies the object exists
 * before inserting.
 */
export function confirmAttachment(
	documentId: string,
	key: string,
	file: File,
): Promise<Attachment> {
	return apiFetch<Attachment>(
		`/api/documents/${documentId}/attachments/confirm`,
		{
			method: "POST",
			body: {
				key,
				filename: file.name,
				contentType: file.type,
				size: file.size,
			},
		},
	);
}

/**
 * Upload an image attachment using the presigned-URL flow:
 *
 *   1. POST /attachments/presign  — get a signed storage PUT URL (small JSON).
 *   2. PUT  <presigned URL>        — stream the file bytes to storage directly
 *                                     (NOT through this API process).
 *   3. POST /attachments/confirm   — record the row; backend verifies the
 *                                     object actually exists in storage.
 *
 * The orchestration is transparent to callers — they keep calling
 * `uploadAttachment(documentId, file)` exactly as before. Step 2 never
 * touches `/api/*`, so the Bun/Elysia global body-size cap is irrelevant
 * and large images (up to `MAX_FILE_SIZE`) upload without 413.
 */
export async function uploadAttachment(
	documentId: string,
	file: File,
): Promise<Attachment> {
	const presign = await presignAttachment(documentId, file);

	// Stream the file to storage. We do NOT pass cookies or auth headers —
	// the presigned URL is the only credential storage accepts, and we
	// mustn't taint the signature with extra headers. Disable any
	// default Content-Type the helper might infer; storage's signature
	// was computed against the original Content-Type we sent in the
	// presign request (file.type).
	const putController = new AbortController();
	const putTimeout = setTimeout(
		() => putController.abort(),
		5 * 60_000, // 5 minutes — large image over a slow link
	);
	let putResponse: Response;
	try {
		putResponse = await fetch(presign.url, {
			method: "PUT",
			body: file,
			headers: {
				"Content-Type": file.type,
			},
			signal: putController.signal,
		});
	} finally {
		clearTimeout(putTimeout);
	}

	if (!putResponse.ok) {
		// Mirror the ApiError shape so callers can `catch (e) { e.status }`
		// uniformly. The original presign is now burnt — the URL will
		// expire — but no storage object was created, so the user can just
		// retry without leaking storage.
		throw new Error(
			`Storage upload failed: ${putResponse.status} ${putResponse.statusText}`,
		);
	}

	return confirmAttachment(documentId, presign.key, file);
}

export function listAttachments(
	documentId: string,
): Promise<AttachmentListResponse> {
	return apiFetch<AttachmentListResponse>(
		`/api/documents/${documentId}/attachments`,
	);
}

export function isImageFile(file: File): boolean {
	return file.type.startsWith("image/");
}

export function isFileSizeAllowed(file: File): boolean {
	return file.size <= MAX_FILE_SIZE;
}
