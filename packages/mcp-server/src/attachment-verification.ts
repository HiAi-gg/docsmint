import { createHash } from "node:crypto";
import type { DocsAttachment } from "@hiai-docs/sdk";

export interface AttachmentVerification {
	size: number;
	mimeType: string;
	sha256: string;
}

const MAX_VERIFIED_IMAGE_BYTES = 16 * 1024 * 1024;

/** Read the complete authorized response; a nonempty first chunk is not proof of integrity. */
export async function verifyAttachmentResponse(
	response: Response,
	attachment: Pick<DocsAttachment, "size" | "mimeType">,
): Promise<AttachmentVerification> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The attachment response has no body.");
	try {
		const mimeType = response.headers
			.get("content-type")
			?.split(";")[0]
			?.trim()
			.toLowerCase();
		if (!response.ok || mimeType !== attachment.mimeType.toLowerCase())
			throw new Error(
				"The stored attachment MIME type does not match its record.",
			);
		if (
			!Number.isSafeInteger(attachment.size) ||
			attachment.size <= 0 ||
			attachment.size > MAX_VERIFIED_IMAGE_BYTES
		)
			throw new Error("The attachment exceeds the verification size limit.");
		const declaredLength = response.headers.get("content-length");
		if (
			declaredLength !== null &&
			(!/^[0-9]+$/.test(declaredLength) ||
				Number(declaredLength) !== attachment.size)
		)
			throw new Error(
				"The stored attachment length does not match its record.",
			);
		const hash = createHash("sha256");
		let size = 0;
		let prefix = Buffer.alloc(0);
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > attachment.size || size > MAX_VERIFIED_IMAGE_BYTES)
				throw new Error("The attachment response exceeds its recorded size.");
			if (prefix.length < 12)
				prefix = Buffer.concat([
					prefix,
					Buffer.from(value.subarray(0, 12 - prefix.length)),
				]);
			hash.update(value);
		}
		if (size !== attachment.size)
			throw new Error("The attachment response is incomplete.");
		const imageMatches =
			(mimeType === "image/webp" &&
				prefix.toString("ascii", 0, 4) === "RIFF" &&
				prefix.toString("ascii", 8, 12) === "WEBP") ||
			(mimeType === "image/png" &&
				prefix
					.subarray(0, 8)
					.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
			(mimeType === "image/jpeg" &&
				prefix[0] === 255 &&
				prefix[1] === 216 &&
				prefix[2] === 255) ||
			(mimeType === "image/gif" &&
				["GIF87a", "GIF89a"].includes(prefix.toString("ascii", 0, 6)));
		if (!imageMatches)
			throw new Error("The attachment bytes do not match its image MIME type.");
		return { size, mimeType, sha256: hash.digest("hex") };
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
