/**
 * Apache AGE (GraphRAG) connection bootstrap.
 *
 * Owns the dedicated `postgres` connection used for graph queries. AGE
 * queries go through the `cypher()` function in `ag_catalog`, which is not
 * compatible with Drizzle — that's why this module uses the raw `postgres`
 * driver instead of the shared Drizzle client in `lib/db.ts`.
 *
 * Connection lifecycle:
 *   - `getGraphDb()` lazily opens the connection on first use.
 *   - `initGraph()` runs the idempotent migration that creates the
 *     `docs_graph` property graph plus the vertex/edge labels.
 *   - `closeGraph()` cleanly shuts down the pool on process exit.
 *
 * Failure handling: AGE is feature-flagged and optional. If the connection
 * or the migration fails (e.g. the AGE container isn't running in a dev
 * environment), the module logs a warning and returns `null` from
 * `getGraphDb()`. Callers MUST treat `null` as "graph features disabled"
 * and continue without raising — the embedding/search pipeline must never
 * be blocked by graph availability.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Minimal subset of the `postgres` client surface that the rest of the
 * graph module consumes. We narrow the type so callers don't reach into
 * the raw driver (and so the module is testable with a stub).
 */
export type GraphSqlClient = ReturnType<typeof postgres>;

const GRAPH_NAME = "docs_graph";
const MIGRATION_PATH = "migrations/001_init.sql";
const CONNECT_TIMEOUT_SECONDS = 5;

let graphSql: GraphSqlClient | null = null;
let initAttempted = false;
let initSucceeded = false;

/**
 * Lazily connect to the AGE database and ensure the graph + labels exist.
 *
 * Returns `null` when:
 *   - `AGE_DATABASE_URL` is not configured (graph features disabled)
 *   - the connection fails (container down, wrong credentials)
 *   - the migration fails (graph already in a broken state)
 *
 * Callers must treat `null` as "feature unavailable" and continue.
 * Successful results are memoized — the same connection is reused across
 * all subsequent calls until `closeGraph()` is invoked.
 */
export async function getGraphDb(): Promise<GraphSqlClient | null> {
	if (graphSql && initSucceeded) return graphSql;
	if (initAttempted && !initSucceeded) return null;

	if (!config.AGE_DATABASE_URL) {
		logger.debug(
			"AGE_DATABASE_URL not set — graph features disabled (set AGE_DATABASE_URL to enable GraphRAG)",
		);
		initAttempted = true;
		return null;
	}

	try {
		graphSql = postgres(config.AGE_DATABASE_URL, {
			connect_timeout: CONNECT_TIMEOUT_SECONDS,
			// Conservative pool: AGE queries are short-lived analytical
			// traversals, not high-throughput transactional work.
			max: 5,
			idle_timeout: 30,
			onnotice: () => {
				// Swallow NOTICE/NOTIFY messages from AGE migrations
				// (e.g. "graph already exists" hints). We log them at
				// debug only because they're routine and noisy.
			},
		});

		// Smoke-test the connection. AGE migrations rely on this succeeding
		// before we run DDL — a fast `SELECT 1` catches most network/auth
		// errors without committing to the full migration.
		await graphSql`SELECT 1`;

		await runMigration(graphSql);
		initAttempted = true;
		initSucceeded = true;
		logger.info({ graph: GRAPH_NAME }, "AGE graph initialized");
		return graphSql;
	} catch (err) {
		logger.warn(
			{ err, url: redactUrl(config.AGE_DATABASE_URL) },
			"AGE database unavailable — graph features disabled",
		);
		// Close the partially-initialized client (best-effort) so we don't
		// leak connections across repeated init attempts.
		if (graphSql) {
			try {
				await graphSql.end({ timeout: 1 });
			} catch {
				/* swallow — connection may not be open yet */
			}
			graphSql = null;
		}
		initAttempted = true;
		initSucceeded = false;
		return null;
	}
}

/**
 * Initialize the AGE property graph and its vertex/edge labels.
 *
 * Idempotent — re-running on an already-initialized database is a no-op.
 * The migration SQL uses `create_graph`/`create_vlabel`/`create_elabel`,
 * each of which returns a row whether it creates or already exists.
 *
 * Exposed separately from `getGraphDb()` so tests and operators can trigger
 * initialization explicitly without forcing lazy evaluation.
 */
export async function initGraph(): Promise<boolean> {
	const client = await getGraphDb();
	return client !== null;
}

/**
 * Close the AGE connection. Safe to call multiple times. Used by the
 * graceful-shutdown path in `index.ts`.
 */
export async function closeGraph(): Promise<void> {
	if (graphSql) {
		try {
			await graphSql.end({ timeout: 5 });
		} catch (err) {
			logger.warn({ err }, "Error while closing AGE connection");
		}
		graphSql = null;
		initAttempted = false;
		initSucceeded = false;
	}
}

/**
 * Test-only: reset the singleton so the next `getGraphDb()` call attempts
 * a fresh connection. Not exported in the public API surface (no callers
 * outside tests should need it).
 */
export function _resetGraphForTests(): void {
	graphSql = null;
	initAttempted = false;
	initSucceeded = false;
}

/**
 * Run the SQL migration file at `migrations/001_init.sql`. Resolved relative
 * to this source file so the migration ships with the compiled backend
 * and is reachable from both `bun run` and compiled bundle entry points.
 */
async function runMigration(client: GraphSqlClient): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const sqlPath = join(here, MIGRATION_PATH);
	const sqlText = await readFile(sqlPath, "utf-8");

	// Use `BEGIN/COMMIT` so a partial migration doesn't leave the graph
	// in an inconsistent state. AGE migrations touch several backing tables
	// and a failure mid-way would otherwise be hard to recover from.
	await client.begin(async (tx) => {
		await tx.unsafe(sqlText);
	});
}

/**
 * Strip the password component from a postgres URL for safe logging.
 * Mirrors the helper conventionally used elsewhere in this codebase
 * (see `lib/db.ts` / config validators).
 */
function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.password) parsed.password = "***";
		return parsed.toString();
	} catch {
		return "<unparseable url>";
	}
}
