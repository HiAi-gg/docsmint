import { expect, test } from "bun:test";
import {
	createYDocFromDocument,
	materializeYDoc,
} from "../lib/collaboration-document";

test("seeds a collaboration room from canonical ProseMirror JSON and materializes it", async () => {
	const original = {
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "Hello room" }] },
		],
	};
	const doc = await createYDocFromDocument({
		content: "Hello room",
		contentJson: original,
	});
	const materialized = materializeYDoc(doc);
	expect(materialized.contentJson).toEqual(original);
	expect(materialized.content).toContain("Hello room");
});
