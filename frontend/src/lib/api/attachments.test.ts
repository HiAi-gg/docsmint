import { afterEach, describe, expect, mock, test } from "bun:test";
import { uploadAttachment } from "./attachments";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("attachment upload quota reservation", () => {
	test("passes the opaque reservation from presign to confirm", async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
		const hostFetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				calls.push({ path, body });
				if (path.endsWith("/presign")) {
					return json({
						url: "https://storage.invalid/upload",
						key: "attachments/object",
						uploadToken: "signed-upload-token",
						maxSize: 1024,
						expiresIn: 900,
						quotaReservationId: "reservation-1",
					});
				}
				return json({
					id: "attachment-1",
					filename: "image.png",
					mimeType: "image/png",
					size: 3,
					url: "/attachment",
				});
			},
		) as unknown as typeof fetch;
		globalThis.fetch = mock(
			async () => new Response(null, { status: 200 }),
		) as unknown as typeof fetch;

		await uploadAttachment(
			"document-1",
			new File(["png"], "image.png", { type: "image/png" }),
			hostFetch,
		);

		expect(calls.at(-1)?.body.quotaReservationId).toBe("reservation-1");
		expect(calls.at(-1)?.body.uploadToken).toBe("signed-upload-token");
	});

	test("uses confirm as the reservation release seam after storage failure", async () => {
		const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
		const hostFetch = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				calls.push({ path, body });
				if (path.endsWith("/presign")) {
					return json({
						url: "https://storage.invalid/upload",
						key: "attachments/object",
						uploadToken: "failed-upload-token",
						maxSize: 1024,
						expiresIn: 900,
						quotaReservationId: "reservation-failed",
					});
				}
				return json({ error: "object missing" }, 400);
			},
		) as unknown as typeof fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(null, { status: 503, statusText: "Unavailable" }),
		) as unknown as typeof fetch;

		await expect(
			uploadAttachment(
				"document-1",
				new File(["png"], "image.png", { type: "image/png" }),
				hostFetch,
			),
		).rejects.toThrow("Storage upload failed");
		expect(calls.at(-1)?.path).toEndWith("/confirm");
		expect(calls.at(-1)?.body.quotaReservationId).toBe("reservation-failed");
		expect(calls.at(-1)?.body.uploadToken).toBe("failed-upload-token");
	});
});
