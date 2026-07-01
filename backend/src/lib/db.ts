/**
 * Drizzle database client.
 *
 * Single source of truth for the application's typed Drizzle handle.
 * Routes import `{ db }` and either:
 *   - call `db.select(...).from(...)` directly for non-RLS tables
 *     (Better Auth, swagger, webhooks), or
 *   - wrap their queries in `withTenant(ctx, async (tx) => ...)` for
 *     tenant-scoped tables so the per-request RLS GUCs are installed
 *     on the transaction's connection.
 *
 * Why a plain `drizzle(...)` (no Proxy):
 *   An earlier design wrapped `db` in a Proxy that auto-opened a
 *   transaction whenever an `AsyncLocalStorage` context was active.
 *   That approach relied on Elysia 1.4.x plugin hooks propagating ALS
 *   state into route handlers — which the framework does NOT do for
 *   routes registered in the parent app scope — and on
 *   `Bun.serve({ fetch: wrappedFetch })` to guarantee every request ran
 *   inside the ALS run. The wrapper was fragile and silently dropped
 *   contexts for parent-app routes, leading to RLS violations that
 *   only surfaced under the non-superuser `hiai_app` role.
 *
 *   The explicit `withTenant(ctx, fn)` pattern makes every RLS-aware
 *   query visible at the call site and removes the dependency on
 *   plugin hook scope, AsyncLocalStorage, or Bun.serve internals.
 */

import * as schema from "@hiai-docs/db/schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config";

const client = postgres(config.DATABASE_URL);

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export const db: Database = drizzle(client, { schema });

/**
 * Shared raw postgres-js client. Exposed for callers that need to run
 * raw SQL not covered by the Drizzle query builder (e.g. Apache AGE
 * Cypher queries in `lib/graph/`).
 */
export { client };
