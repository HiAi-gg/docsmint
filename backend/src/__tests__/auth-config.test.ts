import { describe, expect, test } from "bun:test";
import { auth } from "../lib/auth";

describe("email account settings", () => {
	test("exposes Better Auth change-email endpoint", () => {
		expect(auth.api.changeEmail).toBeDefined();
	});
});
