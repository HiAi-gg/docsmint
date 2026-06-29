/**
 * Apache AGE (GraphRAG) bootstrap for the unified database.
 *
 * As of the unified-database migration, AGE lives in the same database
 * as everything else (vector + vectorscale + relations). This module
 * uses the shared Drizzle client from `lib/db.ts` to run the
 * migration that creates the `docs_graph` property graph and its
 * vertex/edge labels, and returns the same client for Cypher queries
 * (`SELECT * FROM cypher('docs_graph', $$ ... $$)`).
 *
 * Failure handling: AGE is feature-flagged and optional. If the
 * extension is not installed in the shared database (e.g. an older
 * deployment that hasn't been migrated yet) the migration is a no-op
 * and `getGraphDb()` returns `null`. Callers MUST treat `null` as
 * "graph features disabled" and continue without raising.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { client as sharedClient } from "../db";
import { logger } from "../logger";

/**
 * Minimal subset of the `postgres` client surface that graph callers
 * need. Narrowing the type keeps the rest of the graph module
 * decoupled from Drizzle.
 */
export type GraphSqlClient = postgres.Sql;

const GRAPH_NAME = "docs_graph";
const MIGRATION_PATH = "migrations/001_init.sql";

let initAttempted = false;
let initSucceeded = false;

/**
 * Lazily run the AGE migration on the shared client and return it
 * for Cypher queries. Returns `null` when migration fails.
 */
export async function getGraphDb(): Promise<GraphSqlClient | null> {
	if (initSucceeded) return sharedClient;
	if (initAttempted) return null;

	initAttempted = true;
	try {
		await sharedClient`SELECT 1`;
		await runMigration(sharedClient);
		initSucceeded = true;
		logger.info({ graph: GRAPH_NAME }, "AGE graph initialized");
		return sharedClient;
	} catch (err) {
		logger.warn({ err }, "AGE database unavailable — graph features disabled");
		return null;
	}
}

/**
 * Reset the migration singleton so the next `getGraphDb()` call
 * re-runs the migration. Test-only — exported under the underscore
 * prefix to keep it out of the public API surface.
 */
export function _resetGraphForTests(): void {
	initAttempted = false;
	initSucceeded = false;
}

/**
 * Run the SQL migration file at `migrations/001_init.sql`. Statements
 * are run one at a time (not inside BEGIN/COMMIT) because AGE 1.7
 * raises "graph already exists" / "label already exists" on a second
 * run; we swallow those specific errors so re-init is idempotent.
 */
async function runMigration(client: GraphSqlClient): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, MIGRATION_PATH);
	const sqlText = await readFile(sqlPath, "utf-8");

	for (const stmt of sqlText.split(/;\s*\n/)) {
		const trimmed = stmt.trim();
		if (!trimmed) continue;
		try {
			await client.unsafe(trimmed);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!/already exists/i.test(msg)) throw err;
		}
	}
}
