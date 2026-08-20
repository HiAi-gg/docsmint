import { describe, expect, test } from "bun:test";
import { hasSessionCookie } from "./session-cookie";

describe("hasSessionCookie", () => {
	test.each([
		"better-auth.session_token",
		"__Secure-better-auth.session_token",
	])("accepts %s", (name) => {
		expect(
			hasSessionCookie({
				get: (key) => (key === name ? "session" : undefined),
			}),
		).toBe(true);
	});

	test("rejects a missing session", () => {
		expect(hasSessionCookie({ get: () => undefined })).toBe(false);
	});
});
