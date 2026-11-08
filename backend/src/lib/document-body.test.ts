import { expect, test } from "bun:test";
import { resolveDocumentBody, sameDocumentBody } from "./document-body";

test("compares JSON objects structurally while preserving array order and formatting", () => {
	const base = {
		content: "text",
		contentJson: { type: "doc", attrs: { width: 10, height: 20 } },
	};
	expect(
		sameDocumentBody(base, {
			content: "text",
			contentJson: { attrs: { height: 20, width: 10 }, type: "doc" },
		}),
	).toBe(true);
	expect(
		sameDocumentBody(base, {
			...base,
			contentJson: { ...base.contentJson, attrs: { width: 20, height: 20 } },
		}),
	).toBe(false);
	expect(
		sameDocumentBody(
			{ content: "text", contentJson: [1, 2] },
			{ content: "text", contentJson: [2, 1] },
		),
	).toBe(false);
});

test("invalidates stale editor JSON only when Markdown changes without a replacement", () => {
	const old = { content: "old", contentJson: { type: "doc" } };
	expect(resolveDocumentBody(old, { content: "new" })).toEqual({
		content: "new",
		contentJson: null,
	});
	expect(resolveDocumentBody(old, { content: "old" })).toEqual(old);
	expect(resolveDocumentBody(old, { contentJson: null })).toEqual({
		content: "old",
		contentJson: null,
	});
});
