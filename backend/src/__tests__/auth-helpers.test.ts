import { describe, expect, test } from "bun:test";
import { createSessionUserIdResolver } from "../lib/auth-helpers";

describe("auth-helpers", () => {
	test("returns the injected principal user id", async () => {
		const headers = new Headers({ authorization: "Bearer unit-token" });
		let receivedHeaders: Headers | undefined;
		const resolveUserId = createSessionUserIdResolver(async (received) => {
			receivedHeaders = received;
			return { userId: "00000000-0000-4000-8000-000000000001" };
		});

		await expect(resolveUserId(headers)).resolves.toBe(
			"00000000-0000-4000-8000-000000000001",
		);
		expect(receivedHeaders).toBe(headers);
	});

	test("returns null when the injected principal resolver rejects authentication", async () => {
		const resolveUserId = createSessionUserIdResolver(async () => null);
		await expect(resolveUserId(new Headers())).resolves.toBeNull();
	});
});
