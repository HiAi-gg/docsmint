import type { ReindexOptions } from "./reindex-options";

export interface ReindexDocumentRow {
	id: string;
	workspaceId: string | null;
}

export interface ReindexProgress {
	scanned: number;
	queued: number;
	skipped: number;
	lastDocumentId: string | null;
}

export interface ReindexScanDependencies {
	loadPage(input: {
		after?: string;
		limit: number;
		all: boolean;
	}): Promise<ReindexDocumentRow[]>;
	queue(row: ReindexDocumentRow): Promise<boolean>;
	onProgress?(progress: ReindexProgress): void;
}

export async function runResumableReindexScan(
	options: ReindexOptions,
	dependencies: ReindexScanDependencies,
): Promise<ReindexProgress> {
	let cursor = options.after;
	let scanned = 0;
	let queued = 0;
	let skipped = 0;
	while (true) {
		const rows = await dependencies.loadPage({
			after: cursor,
			limit: options.batch,
			all: options.all,
		});
		if (rows.length === 0) break;
		scanned += rows.length;
		if (options.dryRun) {
			skipped += rows.length;
		} else {
			for (const row of rows) {
				if (await dependencies.queue(row)) queued += 1;
				else skipped += 1;
			}
		}
		cursor = rows.at(-1)?.id ?? cursor;
		dependencies.onProgress?.({
			scanned,
			queued,
			skipped,
			lastDocumentId: cursor ?? null,
		});
		if (rows.length < options.batch) break;
	}
	return {
		scanned,
		queued,
		skipped,
		lastDocumentId: cursor ?? null,
	};
}
