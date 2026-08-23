import { describe, expect, test } from "bun:test";
import { submitRegistration } from "./register-submission";

describe("registration submission", () => {
	test("reports a rejected sign-up and always clears loading", async () => {
		const loading: boolean[] = [];
		const errors: string[] = [];

		await submitRegistration(
			{ name: "Ada", email: "ada@example.com", password: "password-123" },
			{
				signUp: async () => {
					throw new Error("network failure");
				},
				navigate: async () => undefined,
				onLoading: (value) => loading.push(value),
				onError: (value) => errors.push(value),
				signupError: "Unable to register",
				networkError: "Network unavailable",
			},
		);

		expect(errors).toEqual(["Network unavailable"]);
		expect(loading).toEqual([true, false]);
	});
});
