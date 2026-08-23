import { describe, expect, mock, test } from "bun:test";
import { createShareLink, revokeShareLink } from "./share";

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

	test("keeps the revoke endpoint reachable", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ path: string; method?: string }> = [];
		globalThis.fetch = (async (path, init) => {
			calls.push({ path: String(path), method: init?.method });
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		try {
			await revokeShareLink("share-id");
			expect(calls).toEqual([
				{ path: "/api/share/share-id", method: "DELETE" },
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
