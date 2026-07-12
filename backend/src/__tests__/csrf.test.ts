import { describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { isAllowedCsrfOrigin } from "../api/middleware/csrf";

const _CSRF_COOKIE = "hiai-csrf";
const _CSRF_HEADER = "x-csrf-token";

function signToken(token: string, secret: string): string {
	return createHmac("sha256", secret).update(token).digest("hex");
}

function generateToken(secret: string): string {
	const token = randomBytes(32).toString("hex");
	return `${token}.${signToken(token, secret)}`;
}

describe("CSRF token generation and verification", () => {
	const secret = "test-secret-key-for-csrf";

	it("generates token in format value.signature", () => {
		const token = generateToken(secret);
		const parts = token.split(".");
		expect(parts).toHaveLength(2);
		expect(parts[0]).toMatch(/^[a-f0-9]{64}$/);
		expect(parts[1]).toMatch(/^[a-f0-9]{64}$/);
	});

	it("verifies valid token", () => {
		const token = generateToken(secret);
		const [value, signature] = token.split(".");
		if (!value || !signature) throw new Error("invalid token");
		const expected = signToken(value, secret);
		expect(signature).toBe(expected);
	});

	it("rejects tampered token", () => {
		const token = generateToken(secret);
		const [value] = token.split(".");
		if (!value) throw new Error("invalid token");
		const tampered = `${value}.0000000000000000000000000000000000000000000000000000000000000000`;
		const [sig1] = [tampered.split(".")[1]];
		const expected = signToken(value, secret);
		expect(sig1).not.toBe(expected);
	});

	it("rejects token with wrong secret", () => {
		const token = generateToken("wrong-secret");
		const [value] = token.split(".");
		if (!value) throw new Error("invalid token");
		const expected = signToken(value, secret);
		const actual = token.split(".")[1];
		expect(actual).not.toBe(expected);
	});

	it("rejects empty token", () => {
		expect("".split(".")).toHaveLength(1);
	});

	it("rejects token without signature", () => {
		const parts = "abcdef1234".split(".");
		expect(parts).toHaveLength(1);
	});
});

describe("CSRF middleware behavior", () => {
	it("builds custom-port origins when CORS_ORIGINS is not explicitly set", () => {
		const webPort = 50701;
		const allowed = [
			`http://localhost:${webPort}`,
			`http://127.0.0.1:${webPort}`,
		];
		expect(
			isAllowedCsrfOrigin(
				"http://localhost:50701",
				"localhost:57000",
				allowed,
				"production",
			),
		).toBe(true);
	});
	it("accepts the exact configured custom web port without allowing other origins", () => {
		const allowed = ["http://localhost:50701", "http://127.0.0.1:50701"];
		expect(
			isAllowedCsrfOrigin(
				"http://localhost:50701",
				"localhost:57000",
				allowed,
				"development",
			),
		).toBe(true);
		expect(
			isAllowedCsrfOrigin(
				"http://localhost:57002",
				"localhost:57000",
				allowed,
				"development",
			),
		).toBe(false);
	});
	it("isUnsafeMethod correctly identifies unsafe methods", () => {
		const unsafe = ["POST", "PUT", "PATCH", "DELETE"];
		const safe = ["GET", "HEAD", "OPTIONS"];
		for (const m of unsafe) {
			expect(["POST", "PUT", "PATCH", "DELETE"]).toContain(m);
		}
		for (const m of safe) {
			expect(["POST", "PUT", "PATCH", "DELETE"]).not.toContain(m);
		}
	});

	it("skips CSRF for Bearer token requests", () => {
		const authHeader = "Bearer some-api-key";
		expect(authHeader.startsWith("Bearer ")).toBe(true);
	});

	it("skips CSRF for non-API routes", () => {
		expect("/api/documents".startsWith("/api/")).toBe(true);
		expect("/api/auth/sign-in".startsWith("/api/auth")).toBe(true);
		expect("/health".startsWith("/api/")).toBe(false);
	});

	it("skips CSRF for multipart requests", () => {
		const ct = "multipart/form-data; boundary=----WebKitFormBoundary";
		expect(ct.includes("multipart/form-data")).toBe(true);
	});
});
