import { expect, test } from "bun:test";
import { verifyAttachmentResponse } from "./attachment-verification.js";

const bytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCdwAAAAASUVORK5CYII=",
	"base64",
);
const record = { size: bytes.length, mimeType: "image/png" };

function streamed(
	chunks: Uint8Array[],
	options: { error?: boolean; type?: string; length?: string } = {},
) {
	let index = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else if (options.error) controller.error(new Error("interrupted"));
			else controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	const headers: Record<string, string> = {
		"Content-Type": options.type ?? record.mimeType,
	};
	if (options.length !== undefined) headers["Content-Length"] = options.length;
	return {
		response: new Response(body, { headers }),
		cancelled: () => cancelled,
	};
}

test("verification consumes all chunks and hashes the complete image", async () => {
	const stream = streamed([
		bytes.subarray(0, 1),
		bytes.subarray(1, 9),
		bytes.subarray(9),
	]);
	expect(await verifyAttachmentResponse(stream.response, record)).toEqual({
		...record,
		sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
	});
});

test("a nonempty first chunk does not hide a truncated response", async () => {
	const stream = streamed([bytes.subarray(0, 12)]);
	await expect(
		verifyAttachmentResponse(stream.response, record),
	).rejects.toThrow("incomplete");
});

test("a stream failure after the header is propagated", async () => {
	const stream = streamed([bytes.subarray(0, 12)], { error: true });
	await expect(
		verifyAttachmentResponse(stream.response, record),
	).rejects.toThrow("interrupted");
});

test("oversized responses are cancelled without reading unbounded bytes", async () => {
	const stream = streamed([bytes, bytes, bytes]);
	await expect(
		verifyAttachmentResponse(stream.response, record),
	).rejects.toThrow("exceeds");
	expect(stream.cancelled()).toBe(true);
});

test("response metadata and image signature must agree with the attachment", async () => {
	for (const options of [
		{ type: "text/html" },
		{ length: "1" },
		{ length: "bogus" },
	]) {
		const stream = streamed([bytes], options);
		await expect(
			verifyAttachmentResponse(stream.response, record),
		).rejects.toThrow();
		expect(stream.cancelled()).toBe(true);
	}
	const stream = streamed([Buffer.alloc(bytes.length, 65)]);
	await expect(
		verifyAttachmentResponse(stream.response, record),
	).rejects.toThrow("MIME");
});
