import { describe, expect, test } from "bun:test";
import { envSchema } from "../lib/config-schema";

describe("API-key owner bootstrap", () => {
	test("rejects the documented textual placeholder before a write reaches PostgreSQL", () => {
		expect(
			envSchema.safeParse({ OWNER_ID: "your-user-uuid-from-auth" }).success,
		).toBe(false);
	});

	test("ships a valid UUID default for clean quickstarts", () => {
		const parsed = envSchema.safeParse({});
		expect(parsed.success).toBe(true);
		if (parsed.success)
			expect(parsed.data.OWNER_ID).toMatch(/^[0-9a-f-]{36}$/i);
	});
});
