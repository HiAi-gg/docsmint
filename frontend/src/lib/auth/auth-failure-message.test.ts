import { describe, expect, test } from "bun:test";
import { authFailureMessage } from "./auth-failure-message";

const labels = {
	credentialError: "Invalid email or password",
	networkError: "Network error. Please check your connection.",
};

describe("authFailureMessage", () => {
	test("maps a proxy 502 without a credential message to the network error", () => {
		expect(
			authFailureMessage(
				{ status: 502, error: "Failed to proxy request" },
				labels,
			),
		).toBe(labels.networkError);
	});

	test("maps a proxy error body with no status to the network error", () => {
		expect(
			authFailureMessage({ error: "Failed to proxy request" }, labels),
		).toBe(labels.networkError);
	});

	test("keeps an explicit credential failure message", () => {
		expect(
			authFailureMessage(
				{ status: 401, message: "Invalid email or password" },
				labels,
			),
		).toBe(labels.credentialError);
	});
});
