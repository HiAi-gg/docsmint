import { describe, expect, test } from "bun:test";

// The route integration harness installs a faithful auth stub globally. Load a
// distinct module identity here so this contract always inspects the real
// Better Auth configuration, independent of Bun test scheduling.
// @ts-expect-error Bun supports query-suffixed TypeScript module imports.
const { auth } = await import("../lib/auth.ts?auth-config-unit");

describe("email account settings", () => {
	test("exposes Better Auth change-email endpoint", () => {
		expect(auth.api.changeEmail).toBeDefined();
	});
});
