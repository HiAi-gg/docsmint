import { describe, expect, test } from "bun:test";
import { canTransition } from "../embedding/generation";

describe("embedding generation lifecycle", () => {
	test("allows only valid lifecycle transitions", () => {
		expect(canTransition("pending", "processing")).toBe(true);
		expect(canTransition("processing", "ready")).toBe(true);
		expect(canTransition("processing", "failed")).toBe(true);
		expect(canTransition("ready", "stale")).toBe(true);
		expect(canTransition("failed", "ready")).toBe(false);
	});

	test("does not allow a failed candidate to replace an active generation", () => {
		expect(canTransition("failed", "ready")).toBe(false);
		expect(canTransition("failed", "processing")).toBe(true);
	});
});
