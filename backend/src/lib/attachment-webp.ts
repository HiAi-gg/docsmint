import sharp from "sharp";

const maxPixels = 40_000_000;
const maxFrames = 120;
const sourceMime = {
	png: "image/png",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
} as const;

export { committedAttachmentKey, pendingWebpAttachmentKey } from "./attachment-image-key";
import { committedAttachmentKey } from "./attachment-image-key";

// The presigned source can change after HEAD. Bound the stream as it arrives
// and reject a different byte length before decoding or reserving final quota.
export async function readAttachmentImageSource(
	source: AsyncIterable<Uint8Array>,
	expectedBytes: number,
	maxBytes: number,
): Promise<Buffer> {
	if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maxBytes) {
		throw new Error("Invalid attachment source size");
	}
	const bytes = Buffer.allocUnsafe(expectedBytes);
	let offset = 0;
	for await (const chunk of source) {
		if (chunk.byteLength > expectedBytes - offset) {
			throw new Error("Attachment source size changed");
		}
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (offset !== expectedBytes) throw new Error("Attachment source size changed");
	return bytes;
}

export async function normalizeAttachmentImage(
	source: Buffer,
	mimeType: string,
	filename: string,
	maxOutputBytes: number,
) {
	const image = sharp(source, {
		animated: true,
		failOn: "warning",
		limitInputPixels: maxPixels,
	});
	const { format, pages = 1, width, height, pageHeight } = await image.metadata();
	if (!format || !Object.hasOwn(sourceMime, format) ||
		sourceMime[format as keyof typeof sourceMime] !== mimeType) {
		throw new Error("Unsupported attachment image format");
	}
	if (!width || !height || pages > maxFrames || width * (pageHeight ?? height) * pages > maxPixels) {
		throw new Error("Attachment image exceeds decoded size limits");
	}
	const bytes = format === "webp"
		? await image.stats().then(() => source)
		: await image.autoOrient().webp({ lossless: format !== "jpeg", quality: 85 }).toBuffer();
	if (bytes.length > maxOutputBytes) {
		throw new Error("Converted attachment exceeds size limit");
	}
	return {
		bytes,
		mimeType: "image/webp" as const,
		filename: filename.replace(/\.[^.]+$/, "") + ".webp",
	};
}

export class AttachmentImageValidationError extends Error {
	constructor() {
		super("Image could not be validated or converted to WebP");
		this.name = "AttachmentImageValidationError";
	}
}

export async function prepareAttachmentWebp(input: {
	source: AsyncIterable<Uint8Array>;
	expectedBytes: number;
	maxBytes: number;
	mimeType: string;
	filename: string;
	sourceKey: string;
	trackOutput: (key: string, size: number) => Promise<void>;
	writeOutput: (key: string, bytes: Buffer, mimeType: string) => Promise<void>;
}) {
	const storageKey = committedAttachmentKey(input.sourceKey);
	if (storageKey === input.sourceKey) {
		throw new Error("Converted image requires a separate permanent storage key");
	}
	const source = await readAttachmentImageSource(
		input.source, input.expectedBytes, input.maxBytes,
	);
	let image: Awaited<ReturnType<typeof normalizeAttachmentImage>>;
	try {
		image = await normalizeAttachmentImage(
			source, input.mimeType, input.filename, input.maxBytes,
		);
	} catch {
		throw new AttachmentImageValidationError();
	}
	// Persist cleanup authority before PUT so a crash never hides an object.
	await input.trackOutput(storageKey, image.bytes.length);
	await input.writeOutput(storageKey, image.bytes, image.mimeType);
	return {
		storageKey,
		filename: image.filename,
		mimeType: image.mimeType,
		size: image.bytes.length,
	};
}
