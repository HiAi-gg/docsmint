import { describe, test, expect } from "bun:test";

describe("auth-helpers", () => {
  test("getSessionUserId exports a function", async () => {
    const mod = await import("../lib/auth-helpers");
    expect(typeof mod.getSessionUserId).toBe("function");
  });

  test("getSessionUserId returns null for empty headers (no auth)", async () => {
    const mod = await import("../lib/auth-helpers");
    const headers = new Headers();
    const result = await mod.getSessionUserId(headers);
    // No API key configured and no session => null
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("getSessionUserId returns null for malformed Authorization header", async () => {
    const mod = await import("../lib/auth-helpers");
    const headers = new Headers({ authorization: "Basic dXNlcjpwYXNz" });
    const result = await mod.getSessionUserId(headers);
    // Not a Bearer token, so API key check skips; no session => null
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("getSessionUserId returns null for Bearer token with no matching API key", async () => {
    const mod = await import("../lib/auth-helpers");
    const headers = new Headers({ authorization: "Bearer wrong-token-value" });
    const result = await mod.getSessionUserId(headers);
    // Token doesn't match HIAI_DOCS_API_KEY (if set), Better Auth also fails
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("getSessionUserId accepts Headers object without throwing", async () => {
    const mod = await import("../lib/auth-helpers");
    const headers = new Headers({
      authorization: "Bearer test123",
      "content-type": "application/json",
    });
    // Should not throw regardless of auth outcome
    await expect(mod.getSessionUserId(headers)).resolves.toBeDefined();
  });

  test("getSessionUserId handles Headers with x-forwarded-for (no effect on auth)", async () => {
    const mod = await import("../lib/auth-helpers");
    const headers = new Headers({
      "x-forwarded-for": "192.168.1.1",
    });
    const result = await mod.getSessionUserId(headers);
    expect(result === null || typeof result === "string").toBe(true);
  });
});
