/**
 * Background cron for the reembed optimization pipeline (Phase 4).
 *
 * Two independent `setInterval` loops catch up on work that route
 * handlers intentionally deferred (Phase 2):
 *
 *   1. **Metadata-stale scan** — picks up docs whose `metadata_changed_at`
 *      is older than `METADATA_DEBOUNCE_MINUTES` (hardcoded 3 min, paired
 *      with the default 1-min tick for a ~4-min end-to-end catch-up) and
 *      atomic-clears the flag with a timestamp `WHERE` clause so a
 *      concurrent PATCH that bumped the flag to a newer value is never
 *      overwritten. Docs that survive the atomic clear are enqueued via
 *      `enqueueReembed`; the worker subsequently calls
 *      `recordSignificantUpdate` (Phase 3.3) which clears
 *      `metadata_changed_at` again on a successful commit — the
 *      double-clear is harmless.
 *
 *   2. **Idle-pending scan** — finds docs with `pending_minor_changes =
 *      true` whose `last_significant_update_at` is older than
 *      `REEMBED_MAX_IDLE_HOURS` and enqueues them. The worker is
 *      responsible for clearing the flag after a successful embed
 *      commit; this cron does NOT call `recordSignificantUpdate` here.
 *
 * Both scans are fire-and-forget: they run on the configured interval,
 * log + swallow errors via `try/catch`, and survive process restarts by
 * querying the DB on each tick (no in-memory state).
 *
 * Either scan can be disabled independently by setting its interval env
 * var (`METADATA_REEMBED_CRON_INTERVAL_MINUTES` or
 * `REEMBED_CRON_INTERVAL_MINUTES`) to `0`. Disabling a scan prevents the
 * corresponding catch-up work from running — see the warn-level log
 * emitted at startup.
 *
 * Started alongside `startEmbeddingWorker()` from `src/index.ts`. Both
 * background loops are intentionally started immediately at process
 * bootstrap (rather than lazily on first request) so a freshly-restarted
 * process drains any backlog without waiting a full tick.
 */

import { documents } from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { config } from "./config";
import { logger } from "./logger";
import { enqueueReembed } from "./reembed";

/**
 * Debounce window for metadata-only re-embeds. Hard-coded per the
 * reembed-optimization plan: 3 minutes from when the flag was set. Tuned
 * so a typical "drag doc between folders, then back" sequence (a few
 * seconds of two consecutive `recordMetadataChange` calls) does not
 * generate any embedding work — the debounce absorbs it.
 */
const METADATA_DEBOUNCE_MINUTES = 3;

/**
 * Cap on rows scanned per cron tick. 100 keeps a single tick well under
 * ~1s on a moderately-sized `documents` table while still draining
 * typical backlogs in a handful of ticks. Both scans hit dedicated
 * partial indexes (`idx_documents_pending_minor_idle`,
 * `idx_documents_metadata_changed`) so the cap is the dominant bound,
 * not raw scan cost.
 */
const CRON_BATCH_SIZE = 100;
const CRON_TENANT = adminTenantContext(ZERO_UUID);

/**
 * Start both background scan loops. Designed to be called once during
 * process bootstrap (next to `startEmbeddingWorker`). Idempotent: this
 * module keeps no module-level state beyond the two `setInterval`
 * handles it owns, so a second call would just spawn two more intervals
 * — callers should not invoke it twice.
 *
 * The function does NOT await either initial scan; both fire-and-forget,
 * matching the `startEmbeddingWorker` convention. Failures inside either
 * tick are logged and swallowed so a transient DB blip cannot kill the
 * loop.
 */
export function startReembedCron(): void {
	const metadataIntervalMs =
		config.METADATA_REEMBED_CRON_INTERVAL_MINUTES * 60 * 1000;

	if (metadataIntervalMs > 0) {
		logger.info(
			{ intervalMinutes: config.METADATA_REEMBED_CRON_INTERVAL_MINUTES },
			"Reembed metadata-stale cron started",
		);
		// Fire immediately on startup so a freshly-restarted process
		// drains any backlog without waiting a full tick.
		void processStaleMetadataChanges().catch((err: unknown) => {
			logger.error({ err }, "Reembed metadata-stale cron initial run failed");
		});
		setInterval(() => {
			void processStaleMetadataChanges().catch((err: unknown) => {
				logger.error({ err }, "Reembed metadata-stale cron tick failed");
			});
		}, metadataIntervalMs);
	} else {
		logger.warn(
			"METADATA_REEMBED_CRON_INTERVAL_MINUTES=0 — metadata-stale cron is DISABLED. " +
				"Metadata-only changes will NOT trigger re-embed until the cron is re-enabled.",
		);
	}

	const idleIntervalMs = config.REEMBED_CRON_INTERVAL_MINUTES * 60 * 1000;

	if (idleIntervalMs > 0) {
		logger.info(
			{ intervalMinutes: config.REEMBED_CRON_INTERVAL_MINUTES },
			"Reembed idle-pending cron started",
		);
		void processIdlePendingChanges().catch((err: unknown) => {
			logger.error({ err }, "Reembed idle-pending cron initial run failed");
		});
		setInterval(() => {
			void processIdlePendingChanges().catch((err: unknown) => {
				logger.error({ err }, "Reembed idle-pending cron tick failed");
			});
		}, idleIntervalMs);
	} else {
		logger.warn(
			"REEMBED_CRON_INTERVAL_MINUTES=0 — idle-pending cron is DISABLED. " +
				"Sub-threshold edits will NOT trigger catch-up embeds until the cron is re-enabled.",
		);
	}
}

/**
 * Scan for docs whose `metadata_changed_at` is older than
 * `METADATA_DEBOUNCE_MINUTES` and enqueue them for re-embed. The
 * atomic-clearing step (`UPDATE ... WHERE metadata_changed_at =
 * <original_ts>`) is what keeps the loop safe against R3 from the plan:
 * if a concurrent PATCH bumped the flag to a newer timestamp between
 * our `SELECT` and our `UPDATE`, the `WHERE` clause matches zero rows
 * and we leave the flag alone for the next tick to pick up.
 */
async function processStaleMetadataChanges(): Promise<void> {
	const cutoff = new Date(Date.now() - METADATA_DEBOUNCE_MINUTES * 60 * 1000);

	const stale = await withTenant(CRON_TENANT, (tx) =>
		tx
			.select({
				id: documents.id,
				metadataChangedAt: documents.metadataChangedAt,
			})
			.from(documents)
			.where(
				and(
					isNotNull(documents.metadataChangedAt),
					lt(documents.metadataChangedAt, cutoff),
				),
			)
			.orderBy(documents.metadataChangedAt)
			.limit(CRON_BATCH_SIZE),
	);

	if (stale.length === 0) return;

	logger.debug(
		{ count: stale.length },
		"Reembed cron: processing stale metadata changes",
	);

	let enqueued = 0;
	for (const row of stale) {
		// `RETURNING id` lets us detect whether the atomic WHERE clause
		// matched (no concurrent PATCH modified metadata_changed_at
		// between SELECT and UPDATE). If RETURNING yielded zero rows we
		// skip the enqueue — a newer PATCH staked its claim and will be
		// picked up by the next tick after the debounce window elapses.
		// The Date we read from Drizzle must be serialised to ISO 8601
		// before interpolation: the `postgres` driver rejects raw Date
		// instances ("argument must be of type string"), and the typed
		// Drizzle `set()` API is not available inside a raw `sql` block.
		const originalTimestamp =
			row.metadataChangedAt instanceof Date
				? row.metadataChangedAt.toISOString()
				: String(row.metadataChangedAt);
		const cleared = await withTenant(CRON_TENANT, (tx) =>
			tx.execute(sql`
				UPDATE documents
				SET metadata_changed_at = NULL
				WHERE id = ${row.id}
				  AND metadata_changed_at = ${originalTimestamp}
				RETURNING id
			`),
		);
		if (Array.isArray(cleared) && cleared.length > 0) {
			await enqueueReembed([row.id]);
			enqueued += 1;
		}
	}

	if (enqueued > 0) {
		logger.info(
			{ scanned: stale.length, enqueued },
			"Reembed cron: enqueued stale metadata changes",
		);
	}
}

/**
 * Test-only: directly invoke the metadata-stale scan without starting the
 * `setInterval` loop. Mirrors the private `processStaleMetadataChanges` so
 * unit tests can assert the per-row UPDATE + enqueue behavior in isolation
 * (no time-mocking, no leaked intervals). Not part of the public API.
 *
 * @internal
 */
export function _processStaleMetadataChangesForTests(): Promise<void> {
	return processStaleMetadataChanges();
}

/**
 * Scan for docs with `pending_minor_changes = true` whose idle window
 * has elapsed (last significant re-embed was `REEMBED_MAX_IDLE_HOURS`
 * hours ago) and enqueue each one for re-embed. The worker is
 * responsible for clearing `pending_minor_changes` after a successful
 * embed commit (via `recordSignificantUpdate`); this cron does NOT call
 * the record function here.
 *
 * Note: docs whose `last_significant_update_at` is still `NULL` —
 * typically created before the reembed optimization shipped — are NOT
 * matched by this scan (`NULL < cutoff` is `NULL`, filtered out by
 * PostgreSQL). Those docs are caught at the route boundary by
 * `shouldTriggerContentReembed`'s null-check in `reembed.ts`, which
 * treats them as immediately idle. The clean separation is intentional:
 * this scan only covers "last touched N hours ago" docs.
 */
async function processIdlePendingChanges(): Promise<void> {
	const cutoff = new Date(
		Date.now() - config.REEMBED_MAX_IDLE_HOURS * 3_600_000,
	);

	const idle = await withTenant(CRON_TENANT, (tx) =>
		tx
			.select({ id: documents.id })
			.from(documents)
			.where(
				and(
					eq(documents.pendingMinorChanges, true),
					lt(documents.lastSignificantUpdateAt, cutoff),
				),
			)
			.orderBy(documents.lastSignificantUpdateAt)
			.limit(CRON_BATCH_SIZE),
	);

	if (idle.length === 0) return;

	logger.debug(
		{ count: idle.length },
		"Reembed cron: processing idle pending-minor changes",
	);

	let enqueued = 0;
	for (const row of idle) {
		await enqueueReembed([row.id]);
		enqueued += 1;
	}

	if (enqueued > 0) {
		logger.info(
			{ scanned: idle.length, enqueued },
			"Reembed cron: enqueued idle pending-minor changes",
		);
	}
}

/**
 * Test-only: directly invoke the idle-pending scan. Same rationale as
 * `_processStaleMetadataChangesForTests` — gives unit tests a handle on the
 * otherwise private scan function without going through `setInterval`.
 * Not part of the public API.
 *
 * @internal
 */
export function _processIdlePendingChangesForTests(): Promise<void> {
	return processIdlePendingChanges();
}
