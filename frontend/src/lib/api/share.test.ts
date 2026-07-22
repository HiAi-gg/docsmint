import { describe, expect, mock, test } from "bun:test";
import { createShareLink } from "./share";

describe("share API client", () => {
	test("uses the injected host fetcher for share mutations", async () => {
		const hostFetch = mock(
			async () =>
				new Response(JSON.stringify({ token: "share" }), {
					status: 201,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		await createShareLink({ documentId: "document-id" }, hostFetch);
		expect(hostFetch).toHaveBeenCalledWith(
			"/api/share",
			expect.objectContaining({ method: "POST" }),
		);
	});
});
