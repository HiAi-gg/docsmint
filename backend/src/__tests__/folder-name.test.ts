import { describe, expect, test } from "bun:test";
import { nextAvailableFolderName } from "../lib/folder-name";

describe("nextAvailableFolderName", () => {
	test("keeps the requested name when it is available", () => {
		expect(nextAvailableFolderName("Plans", ["Other"])).toBe("Plans");
	});

	test("numbers duplicates from two and fills suffix gaps", () => {
		expect(
			nextAvailableFolderName("Plans", ["Plans", "Plans 2", "Plans 4"]),
		).toBe("Plans 3");
	});

	test("keeps generated names within the API length limit", () => {
		const base = "x".repeat(255);
		const result = nextAvailableFolderName(base, [base]);
		expect(result).toHaveLength(255);
		expect(result.endsWith(" 2")).toBe(true);
	});
});
