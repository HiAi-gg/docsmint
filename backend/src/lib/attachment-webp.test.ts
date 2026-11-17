import { expect, test } from "bun:test";
import sharp from "sharp";
import {
	committedAttachmentKey,
	normalizeAttachmentImage,
	pendingWebpAttachmentKey,
	prepareAttachmentWebp,
	readAttachmentImageSource,
} from "./attachment-webp";

test("normalizes PNG with alpha and preserves the resulting WebP on re-upload", async () => {
	const png = await sharp({
		create: {
			width: 3,
			height: 2,
			channels: 4,
			background: { r: 20, g: 40, b: 80, alpha: 0.5 },
		},
	})
		.png()
		.toBuffer();
	const result = await normalizeAttachmentImage(
		png,
		"image/png",
		"diagram.png",
		2048,
	);
	expect(result.filename).toBe("diagram.webp");
	expect(result.mimeType).toBe("image/webp");
	expect(await sharp(result.bytes).metadata()).toMatchObject({
		format: "webp",
		width: 3,
		height: 2,
		hasAlpha: true,
	});
	expect(await sharp(result.bytes).raw().toBuffer()).toEqual(
		await sharp(png).raw().toBuffer(),
	);
	expect(
		(
			await normalizeAttachmentImage(
				result.bytes,
				"image/webp",
				result.filename,
				2048,
			)
		).bytes,
	).toEqual(result.bytes);
	await expect(
		normalizeAttachmentImage(png, "image/jpeg", "diagram.jpg", 2048),
	).rejects.toThrow("format");
	await expect(
		normalizeAttachmentImage(png, "image/png", "diagram.png", 1),
	).rejects.toThrow("size");
});

test("reads the admitted source length and rejects truncated or replaced streams", async () => {
	async function* source() {
		yield Uint8Array.of(137, 80);
		yield Uint8Array.of(78, 71);
	}
	expect(await readAttachmentImageSource(source(), 4, 5)).toEqual(
		Buffer.from([137, 80, 78, 71]),
	);
	await expect(readAttachmentImageSource(source(), 3, 5)).rejects.toThrow(
		"size changed",
	);
	await expect(readAttachmentImageSource(source(), 5, 5)).rejects.toThrow(
		"size changed",
	);
	await expect(readAttachmentImageSource(source(), 6, 5)).rejects.toThrow(
		"source size",
	);
});

test("reserves separate keys for the presigned source and committed WebP", () => {
	const pending = pendingWebpAttachmentKey("workspace/user/document", "upload");
	expect(pending).toBe("workspace/user/document/upload.webp.pending");
	expect(committedAttachmentKey(pending)).toBe(
		"workspace/user/document/upload.webp",
	);
	expect(committedAttachmentKey("workspace/user/document/legacy.png")).toBe(
		"workspace/user/document/legacy.png",
	);
});

test("tracks the final WebP before storage and returns actual stored metadata", async () => {
	const png = await sharp({
		create: { width: 2, height: 2, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const events: string[] = [];
	let stored: Buffer | undefined;
	const result = await prepareAttachmentWebp({
		source: (async function* () {
			yield png;
		})(),
		expectedBytes: png.length,
		maxBytes: 2048,
		mimeType: "image/png",
		filename: "picture.png",
		sourceKey: pendingWebpAttachmentKey("private/document", "admission"),
		trackOutput: async (key, size) => {
			events.push("tracked");
			expect(key).toBe("private/document/admission.webp");
			expect(size).toBeGreaterThan(0);
		},
		writeOutput: async (_key, bytes, mime) => {
			events.push("written");
			expect(mime).toBe("image/webp");
			stored = bytes;
		},
	});
	expect(events).toEqual(["tracked", "written"]);
	expect(result).toMatchObject({
		filename: "picture.webp",
		mimeType: "image/webp",
		size: stored!.length,
	});
	expect((await sharp(stored!).metadata()).format).toBe("webp");
});

test("a storage failure cannot report a prepared image", async () => {
	const png = await sharp({
		create: { width: 1, height: 1, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	let tracked = false;
	await expect(
		prepareAttachmentWebp({
			source: (async function* () {
				yield png;
			})(),
			expectedBytes: png.length,
			maxBytes: 2048,
			mimeType: "image/png",
			filename: "picture.png",
			sourceKey: pendingWebpAttachmentKey("private/document", "failed"),
			trackOutput: async () => {
				tracked = true;
			},
			writeOutput: async () => {
				throw new Error("storage unavailable");
			},
		}),
	).rejects.toThrow("storage unavailable");
	expect(tracked).toBe(true);
});

test("orients JPEG pixels before encoding WebP", async () => {
	const jpeg = await sharp({
		create: { width: 6, height: 3, channels: 3, background: "orange" },
	})
		.jpeg()
		.withMetadata({ orientation: 6 })
		.toBuffer();
	const result = await normalizeAttachmentImage(
		jpeg,
		"image/jpeg",
		"photo.jpeg",
		4096,
	);
	const metadata = await sharp(result.bytes).metadata();
	expect(metadata).toMatchObject({ format: "webp", width: 3, height: 6 });
	expect(metadata.orientation).toBeUndefined();
});

test("preserves GIF animation timing, repeat count and frame pixels", async () => {
	const first = Buffer.from([255, 0, 0, 255, 0, 0]);
	const second = Buffer.from([0, 0, 255, 0, 0, 255]);
	const gif = await sharp(Buffer.concat([first, second]), {
		raw: { width: 2, height: 2, channels: 3, pageHeight: 1 },
	})
		.gif({ delay: [100, 200], loop: 3 })
		.toBuffer();
	const result = await normalizeAttachmentImage(
		gif,
		"image/gif",
		"animation.gif",
		4096,
	);
	const metadata = await sharp(result.bytes, { animated: true }).metadata();
	expect(metadata).toMatchObject({
		format: "webp",
		width: 2,
		pages: 2,
		pageHeight: 1,
		delay: [100, 200],
		loop: 3,
	});
	expect(
		await sharp(result.bytes, { animated: true })
			.ensureAlpha()
			.raw()
			.toBuffer(),
	).toEqual(
		await sharp(gif, { animated: true }).ensureAlpha().raw().toBuffer(),
	);
});

test("rejects malformed images and excessive animation frames before publication", async () => {
	await expect(
		normalizeAttachmentImage(
			Buffer.from("broken"),
			"image/png",
			"broken.png",
			4096,
		),
	).rejects.toThrow();
	const gif = await sharp(
		Buffer.from(
			Array.from({ length: 121 }, (_, frame) => [
				frame * 2,
				255 - frame * 2,
				frame,
			]).flat(),
		),
		{
			raw: { width: 1, height: 121, channels: 3, pageHeight: 1 },
		},
	)
		.gif({
			delay: Array.from({ length: 121 }, () => 10),
			interFrameMaxError: 0,
			interPaletteMaxError: 0,
		})
		.toBuffer();
	await expect(
		normalizeAttachmentImage(gif, "image/gif", "large.gif", 4096),
	).rejects.toThrow("decoded size");
});

test("caps concurrent conversions and releases capacity after failures", async () => {
	const png = await sharp({
		create: { width: 2, height: 2, channels: 3, background: "white" },
	})
		.png()
		.toBuffer();
	const first = normalizeAttachmentImage(png, "image/png", "first.png", 4096);
	const second = normalizeAttachmentImage(png, "image/png", "second.png", 4096);
	await expect(
		normalizeAttachmentImage(png, "image/png", "third.png", 4096),
	).rejects.toThrow("capacity");
	await Promise.all([first, second]);
	await expect(
		normalizeAttachmentImage(png, "image/png", "small.png", 1),
	).rejects.toThrow("size");
	expect(
		(await normalizeAttachmentImage(png, "image/png", "retry.png", 4096))
			.mimeType,
	).toBe("image/webp");
});
