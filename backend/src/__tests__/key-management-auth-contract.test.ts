import { describe, expect, test } from "bun:test";

const ROUTE_PATH = new URL("../api/routes/keys.ts", import.meta.url).pathname;

describe("API key management authentication contract", () => {
	test("all key-management handlers require a Better Auth browser session", async () => {
		const source = await Bun.file(ROUTE_PATH).text();
		expect(source).not.toContain('.post("/keys",');
		expect(
			source.match(/resolveBrowserSessionUserId\(request\.headers\)/g),
		).toHaveLength(5);
		expect(source.match(/Browser session required/g)).toHaveLength(5);
	});
});
