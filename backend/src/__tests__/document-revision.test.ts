import { describe, expect, test } from "bun:test";
import { contentHash } from "../lib/content-hash";
import { resolveDocumentRevision } from "../queue/document-revision";

describe("pipeline document revision", () => {
	test("preserves the stored revision", () => {
		expect(resolveDocumentRevision("stored", "Title", "Body")).toBe("stored");
	});

	test("computes a deterministic fallback for legacy null hashes", () => {
		expect(resolveDocumentRevision(null, "Title", "Body")).toBe(
			contentHash("Title", "Body"),
		);
	});
});
