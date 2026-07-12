import { describe, expect, test } from "bun:test";
import {
	encodeS3CopySource,
	planDuplicateAttachments,
	rewriteDuplicateAttachmentReferences,
} from "../lib/duplicate-attachments";

describe("document attachment duplication", () => {
	test("creates new document-scoped IDs and rewrites Markdown and JSON", () => {
		const plans = planDuplicateAttachments(
			[
				{
					id: "old-id",
					filename: "image.png",
					mimeType: "image/png",
					size: 42,
					storageKey: "owner/source/original.png",
				},
			],
			"owner",
			"copy-doc",
			() => "new-id",
		);
		expect(plans[0]?.storageKey).toBe("owner/copy-doc/new-id.png");

		const rewritten = rewriteDuplicateAttachmentReferences(
			{
				content: "![image](/api/attachments/old-id/raw)",
				contentJson: {
					attrs: { src: "/api/attachments/old-id/raw" },
				},
			},
			plans,
		);
		expect(rewritten.content).toContain("/api/attachments/new-id/raw");
		expect(rewritten.contentJson.attrs.src).toBe("/api/attachments/new-id/raw");
	});

	test("encodes storage keys for S3 server-side copy", () => {
		expect(encodeS3CopySource("docs", "user/doc/my image.png")).toBe(
			"docs/user/doc/my%20image.png",
		);
	});
});
