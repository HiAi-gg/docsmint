import { describe, expect, test } from "bun:test";
import { runResumableReindexScan } from "../scripts/reindex-scan";

describe("full reindex resumption", () => {
	test("continues after the supplied cursor and queues every remaining active document", async () => {
		const pages = [
			[
				{ id: "doc-101", workspaceId: null },
				{ id: "doc-102", workspaceId: "workspace-a" },
			],
			[{ id: "doc-103", workspaceId: null }],
		];
		const cursors: Array<string | undefined> = [];
		const queued: Array<{ id: string; workspaceId?: string }> = [];
		const result = await runResumableReindexScan(
			{ after: "doc-100", batch: 2, dryRun: false, all: true },
			{
				loadPage: async ({ after, all }) => {
					cursors.push(after);
					expect(all).toBe(true);
					return pages.shift() ?? [];
				},
				queue: async (row) => {
					queued.push({
						id: row.id,
						workspaceId: row.workspaceId ?? undefined,
					});
					return true;
				},
			},
		);

		expect(cursors).toEqual(["doc-100", "doc-102"]);
		expect(queued).toEqual([
			{ id: "doc-101" },
			{ id: "doc-102", workspaceId: "workspace-a" },
			{ id: "doc-103" },
		]);
		expect(result).toEqual({
			scanned: 3,
			queued: 3,
			skipped: 0,
			lastDocumentId: "doc-103",
		});
	});
});
