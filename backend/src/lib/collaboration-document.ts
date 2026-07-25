import { generateText, getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import type * as Y from "yjs";
import { editorExtensions } from "./editor-schema";

const schema = getSchema(editorExtensions);
const FIELD = "default";
const emptyDocument = { type: "doc", content: [{ type: "paragraph" }] };

export async function createYDocFromDocument(input: {
	content: string | null;
	contentJson: unknown;
}): Promise<Y.Doc> {
	const text = input.content?.trim();
	const json =
		input.contentJson ??
		(text
			? {
					type: "doc",
					content: [{ type: "paragraph", content: [{ type: "text", text }] }],
				}
			: emptyDocument);
	return prosemirrorJSONToYDoc(schema, json, FIELD);
}

export function materializeYDoc(doc: Y.Doc): {
	content: string;
	contentJson: Record<string, unknown>;
} {
	const contentJson = yDocToProsemirrorJSON(doc, FIELD);
	return {
		content: generateText(contentJson, editorExtensions),
		contentJson,
	};
}
