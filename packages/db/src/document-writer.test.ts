import { describe, expect, test } from "bun:test";

import {
	createDocumentWithVersion,
	trashDocuments,
	updateDocumentWithVersion,
} from "./document-writer";

function fakeTransaction() {
	const actions: Array<{ kind: string; values: Record<string, unknown> }> = [];
	return {
		actions,
		tx: {
			execute: async () => {
				actions.push({ kind: "pipeline-lock", values: {} });
				return [];
			},
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					actions.push({ kind: "insert", values });
					return {
						returning: async () => [{ id: values.id ?? "created-doc" }],
					};
				},
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					actions.push({ kind: "update", values });
					return {
						where: () => ({ returning: async () => [{ id: "doc-a" }] }),
					};
				},
			}),
		},
	};
}

describe("public transactional document writer", () => {
	test("updates a document and records the canonical version in one transaction", async () => {
		const fake = fakeTransaction();
		const result = await updateDocumentWithVersion(fake.tx as never, {
			documentId: "doc-a",
			workspaceId: "workspace-a",
			actorUserId: "user-a",
			content: "updated",
			contentJson: { type: "doc" },
		});
		expect(result).toEqual({ id: "doc-a" });
		expect(fake.actions.map((action) => action.kind)).toEqual([
			"update",
			"insert",
		]);
		expect(fake.actions[1]?.values).toMatchObject({
			documentId: "doc-a",
			workspaceId: "workspace-a",
			createdBy: "user-a",
			content: "updated",
		});
	});

	test("creates a document with its initial version and trashes an exact workspace set", async () => {
		const fake = fakeTransaction();
		const created = await createDocumentWithVersion(fake.tx as never, {
			ownerId: "user-a",
			workspaceId: "workspace-a",
			title: "Merged",
			content: "merged",
			contentJson: { type: "doc" },
			visibility: "private",
		});
		expect(created).toEqual({ id: "created-doc" });
		expect(fake.actions.map((action) => action.kind)).toEqual([
			"insert",
			"insert",
		]);

		const trashed = await trashDocuments(fake.tx as never, {
			workspaceId: "workspace-a",
			documentIds: ["doc-a", "doc-b"],
		});
		expect(trashed).toEqual([{ id: "doc-a" }]);
		expect(fake.actions.slice(-2).map((action) => action.kind)).toEqual([
			"pipeline-lock",
			"update",
		]);
		expect(fake.actions.at(-1)?.values.deletedAt).toBeInstanceOf(Date);
	});
});
