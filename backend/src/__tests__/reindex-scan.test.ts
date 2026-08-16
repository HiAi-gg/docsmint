import { describe, expect, test } from "bun:test";
import * as ReindexScan from "../scripts/reindex-scan";

const { runResumableReindexScan } = ReindexScan;

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

describe("tenant-scoped reindex page loading", () => {
	test("runs the production page loader inside the supplied RLS transaction", async () => {
		const loadTenantScopedReindexPage = (
			ReindexScan as typeof ReindexScan & {
				loadTenantScopedReindexPage?: <T>(
					input: { after?: string; limit: number; all: boolean },
					dependencies: {
						withTenant: (operation: (tx: object) => Promise<T>) => Promise<T>;
						loadPage: (
							tx: object,
							input: { after?: string; limit: number; all: boolean },
						) => Promise<T>;
					},
				) => Promise<T>;
			}
		).loadTenantScopedReindexPage;
		expect(typeof loadTenantScopedReindexPage).toBe("function");
		const tenantTx = { name: "rls-transaction" };
		const seen: object[] = [];
		const rows = await loadTenantScopedReindexPage?.(
			{ after: "doc-1", limit: 10, all: true },
			{
				withTenant: async (operation) => operation(tenantTx),
				loadPage: async (tx) => {
					seen.push(tx);
					return [{ id: "doc-2" }];
				},
			},
		);
		expect(seen).toEqual([tenantTx]);
		expect(rows).toEqual([{ id: "doc-2" }]);
	});
});
