import { describe, expect, test } from "bun:test";

const loginPageSource = await Bun.file(
	`${import.meta.dir}/../../routes/login/+page.svelte`,
).text();

describe("login failure feedback", () => {
	test("bounds the auth request and forwards its abort signal", () => {
		expect(loginPageSource).toContain("const LOGIN_TIMEOUT_MS = 15_000");
		expect(loginPageSource).toContain(
			"const controller = new AbortController()",
		);
		expect(loginPageSource).toContain("controller.abort()");
		expect(loginPageSource).toContain("{ signal: controller.signal }");
	});

	test("always clears loading and reports safe retryable failures", () => {
		expect(loginPageSource).toContain("} catch {");
		expect(loginPageSource).toContain(
			"controller.signal.aborted ? m.error_timeout() : m.error_network()",
		);
		expect(loginPageSource).toContain("} finally {");
		expect(loginPageSource).toContain("clearTimeout(timeout)");
		expect(loginPageSource).toContain("loading = false");
	});

	test("maps API proxy failures through authFailureMessage instead of credential copy", () => {
		expect(loginPageSource).toContain(
			'import { authFailureMessage } from "$lib/auth/auth-failure-message"',
		);
		expect(loginPageSource).toContain("authFailureMessage(result.error, {");
		expect(loginPageSource).toContain("credentialError: m.auth_login_error()");
		expect(loginPageSource).toContain("networkError: m.error_network()");
		expect(loginPageSource).not.toContain(
			"result.error.message ?? m.auth_login_error()",
		);
	});
});
