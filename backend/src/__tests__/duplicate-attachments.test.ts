import { describe, expect, test } from "bun:test";
import {
	encodeS3CopySource,
	planDuplicateAttachments,
	rewriteDuplicateAttachmentReferences,
} from "../lib/duplicate-attachments";

const documentsRoute = await Bun.file(
	new URL("../api/routes/documents.ts", import.meta.url),
).text();

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

	test("namespaces duplicated objects by external workspace", () => {
		const [plan] = planDuplicateAttachments(
			[
				{
					id: "old-id",
					filename: "image.png",
					mimeType: "image/png",
					size: 42,
					storageKey: "workspace-a/user/source/original.png",
				},
			],
			"user-a",
			"doc-copy",
			() => "attachment-a",
			"workspace-a",
		);
		expect(plan?.storageKey).toBe(
			"workspace-a/user-a/doc-copy/attachment-a.png",
		);
	});

	test("workspace duplication reserves quota before copy and never stages none-kind copies", () => {
		const duplicateStart = documentsRoute.indexOf(
			"POST /api/documents/:id/duplicate",
		);
		const duplicate = documentsRoute.slice(
			duplicateStart,
			documentsRoute.indexOf("// GET /api/trash", duplicateStart),
		);
		expect(duplicate).toContain('? "reserve_pending"');
		expect(duplicate).toContain("quotaAdmission.reserve(context)");
		expect(duplicate).toContain("quotaAdmission.finalize(");
		expect(duplicate).toContain('quotaReleaseKind: "reservation"');
		expect(duplicate).toContain('quotaReleaseKind: "committed"');
		expect(duplicate).toContain("releaseReservation(");
		expect(duplicate).toContain("notBefore: storageWriteHoldNotBefore()");
		expect(duplicate.indexOf("quotaAdmission.reserve")).toBeLessThan(
			duplicate.indexOf("new CopyObjectCommand"),
		);
		expect(duplicate).not.toMatch(
			/insert\(attachments\)[\s\S]{0,400}quotaReleaseKind:\s*"none"/,
		);
	});
});
