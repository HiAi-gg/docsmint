import { describe, expect, test } from "bun:test";
import { decryptApiKey, encryptApiKey } from "../lib/api-key-encryption";

const secret = "test-category-key-encryption-secret-32-bytes";

describe("category API key encryption", () => {
	test("round-trips without storing plaintext", async () => {
		const rawKey = "private-category-key";
		const encrypted = await encryptApiKey(rawKey, secret);
		expect(encrypted).toStartWith("v1.");
		expect(encrypted).not.toContain(rawKey);
		expect(await decryptApiKey(encrypted, secret)).toBe(rawKey);
	});

	test("rejects tampered ciphertext", async () => {
		const encrypted = await encryptApiKey("private-category-key", secret);
		const tampered = `${encrypted.slice(0, -2)}AA`;
		await expect(decryptApiKey(tampered, secret)).rejects.toThrow();
	});
});
