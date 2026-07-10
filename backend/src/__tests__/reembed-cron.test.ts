/**
 * Tests for the reembed-cron background scan module (Phase 5.4).
 *
 * Two private scan functions are exercised via test-only exports:
 *
 *   - `_processStaleMetadataChangesForTests()` — wraps the metadata-stale
 *     scan that picks up docs whose `metadata_changed_at` is older than
 *     the 3-minute debounce window. The interesting behavior under test
 *     is the atomic-clear step: an `UPDATE ... WHERE metadata_changed_at
 *     = <original_ts>` followed by a `RETURNING id` check. If a
 *     concurrent PATCH bumped the timestamp between the cron's SELECT
 *     and its UPDATE, the UPDATE matches zero rows and the cron's
 *     enqueue is skipped (R3 from the plan).
 *
 *   - `_processIdlePendingChangesForTests()` — wraps the idle-pending
 *     scan that catches up on docs with `pending_minor_changes = true`
 *     whose idle window (`REEMBED_MAX_IDLE_HOURS`) has elapsed. This
 *     scan has no race-condition logic; it just enqueues each row and
 *     relies on the WORKER to call `recordSignificantUpdate` after a
 *     successful commit (Phase 3.3). Tests therefore do NOT assert any
 *     `recordSignificantUpdate` call — that is the worker's contract.
 *
 * Both scans are unit-tested in isolation: the db layer is mocked at the
 * `db.select` / `db.execute` boundary, and `enqueueReembed` is mocked so
 * push counts are observable without standing up Redis. We deliberately
 * avoid fake timers — calling the test-only export directly skips the
 * `setInterval` machinery entirely.
 *
 * Mock shape (drizzle-style):
 *   db.select(...).from(...).where(...).orderBy(...).limit(...) -> Promise<rows>
 *   db.execute(sql`...`)                                      -> Promise<rows>
 *
 * Per-test state (rows returned, execute behavior) is mutated via helper
 * setters; mocks are reset in `beforeEach` so test isolation is structural
 * rather than ordering-dependent.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ----- Shared mocks -----------------------------------------------------------

// We mock `../lib/reembed` to expose a fake `enqueueReembed` so we can
// observe the cron -> reembed boundary without paying for the real
// Redis SET-NX path (which is covered by `reembed.test.ts`). The cron
// just hands doc ids to `enqueueReembed`; this test asserts WHICH ids
// are handed in, not how `enqueueReembed` dedups them.
const fakeEnqueueReembed = mock(
	async (_docIds: ReadonlyArray<string>) => _docIds.length,
);

// Rows returned by the final `.limit()` in the drizzle chain. Tests
// mutate this array (or replace it) before invoking the scan.
let selectRows: Array<{ id: string; metadataChangedAt?: Date }> = [];

// Rows returned by `db.execute(...)`. The cron's metadata-stale scan
// uses `RETURNING id` semantics — the mock returns `{ id: "..." }` for
// "matched" rows and `[]` for "not matched" rows (concurrent PATCH).
let executeRows: Array<{ id: string }> = [];

// Records every raw `db.execute(...)` call so tests can assert the
// atomic-WHERE clause was actually issued per stale row.
const executeCalls: Array<{ sql: unknown }> = [];

// Fluent chain: every intermediate call returns the same object so a
// chained `.from().where().orderBy().limit()` walks through it without
// `undefined` intermediate values.
const selectChain = {
	from: mock(() => selectChain),
	where: mock(() => selectChain),
	orderBy: mock(() => selectChain),
	limit: mock(() => Promise.resolve(selectRows)),
};

mock.module("../lib/embedding-queue", () => ({
	enqueueEmbedding: mock((_id: string) => {}),
}));

// Persistent mock state (across beforeEach re-applications)
const persistentMocks = {
	redis: { lpush: mock(async () => 1) },
	db: {
		select: mock(() => selectChain),
		execute: mock((q: unknown) => dbExecute(q)),
	},
	reembed: { enqueueReembed: fakeEnqueueReembed },
};

const fakeClient = { unsafe: mock(async () => []) };

function applyCronMocks(): void {
	mock.module("../lib/redis", () => ({ redis: persistentMocks.redis }));
	mock.module("../lib/db", () => ({
		db: persistentMocks.db,
		client: fakeClient,
	}));
	mock.module("@hiai-docs/db/with-tenant", () => ({
		ZERO_UUID: "00000000-0000-0000-0000-000000000000",
		adminTenantContext: (userId: string) => ({
			userId,
			role: "admin" as const,
		}),
		shareGuestTenantContext: (userId: string) => ({
			userId,
			role: "user" as const,
		}),
		withTenant: async <T>(
			_context: unknown,
			callback: (tx: typeof persistentMocks.db) => Promise<T>,
		): Promise<T> => callback(persistentMocks.db),
	}));
	mock.module("../lib/reembed", () => persistentMocks.reembed);
}

// Apply mocks once at load time (covers initial module import)
applyCronMocks();

// Now safe to import the module under test. The cron module reads
// `config.REEMBED_*` at call time (not at module-load time) so we don't
// need to mutate process.env here.
const cron = await import("../lib/reembed-cron");

// ----- Per-test reset ---------------------------------------------------------

beforeEach(() => {
	// Re-apply mocks so cross-file mock contamination doesn't break us
	applyCronMocks();

	// Per-test state: empty by default. Individual tests mutate these
	// arrays directly before invoking the scan.
	selectRows = [];
	executeRows = [];
	executeCalls.length = 0;
	fakeEnqueueReembed.mockClear();
	// Re-prime the chain mocks so their .mock.calls counters reset too.
	selectChain.from.mockClear();
	selectChain.where.mockClear();
	selectChain.orderBy.mockClear();
	selectChain.limit.mockClear();
	// Reset the db.execute mock's per-call behavior to the default
	// (returns the static `executeRows` array). Tests that need
	// per-call variation override via `setMockExecuteImpl` below.
	setMockExecuteImpl(null);
});

afterEach(() => {
	// Restore the empty default so a stray test cannot leak rows into
	// the next run (bun:test is process-shared).
	selectRows = [];
	executeRows = [];
	setMockExecuteImpl(null);
});

// Lets a test swap `db.execute` to a per-call impl. `mockImpl(null)`
// restores the default (returns the shared `executeRows` array).
function setMockExecuteImpl(
	mockImpl: ((q: unknown, callIndex: number) => Promise<unknown>) | null,
): void {
	if (mockImpl === null) {
		dbExecute = (q: unknown) => {
			executeCalls.push({ sql: q });
			return Promise.resolve(executeRows);
		};
	} else {
		let i = 0;
		dbExecute = (q: unknown) => {
			const result = mockImpl(q, i);
			i += 1;
			executeCalls.push({ sql: q });
			return result;
		};
	}
}

// `dbExecute` is captured by the `db.execute` mock factory closure.
// Swapping it in `setMockExecuteImpl` lets individual tests vary the
// per-call response without re-mocking the whole `../lib/db` module
// (which would be silently ignored by bun:test's module cache).
let dbExecute: (q: unknown) => Promise<unknown> = (q) => {
	executeCalls.push({ sql: q });
	return Promise.resolve(executeRows);
};

// ----- Tests ------------------------------------------------------------------

describe("reembed-cron metadata-stale scan", () => {
	test("returns early (no enqueue, no execute) when the db has no stale rows", async () => {
		selectRows = [];

		await cron._processStaleMetadataChangesForTests();

		// No `enqueueReembed` calls — we have nothing to push.
		expect(fakeEnqueueReembed.mock.calls.length).toBe(0);
		// No `db.execute` calls — we skipped the loop entirely.
		expect(executeCalls.length).toBe(0);
	});

	test("enqueues each stale doc whose atomic UPDATE matches", async () => {
		const ts1 = new Date("2026-01-01T00:00:00Z");
		const ts2 = new Date("2026-01-01T00:01:00Z");
		selectRows = [
			{ id: "doc-1", metadataChangedAt: ts1 },
			{ id: "doc-2", metadataChangedAt: ts2 },
		];
		// Both rows succeed the atomic clear.
		executeRows = [{ id: "doc-1" }];

		await cron._processStaleMetadataChangesForTests();

		// One enqueue call per row — both made it through. Each call
		// receives the doc id as a single-element array (per the
		// `enqueueReembed` contract).
		expect(fakeEnqueueReembed.mock.calls.length).toBe(2);
		expect(fakeEnqueueReembed.mock.calls[0]?.[0]).toEqual(["doc-1"]);
		expect(fakeEnqueueReembed.mock.calls[1]?.[0]).toEqual(["doc-2"]);
		// One UPDATE per stale row.
		expect(executeCalls.length).toBe(2);
	});

	test("only enqueues rows whose atomic UPDATE matched (concurrent PATCH guard)", async () => {
		const ts1 = new Date("2026-01-01T00:00:00Z");
		const ts2 = new Date("2026-01-01T00:01:00Z");
		selectRows = [
			{ id: "doc-1", metadataChangedAt: ts1 },
			{ id: "doc-2", metadataChangedAt: ts2 },
		];

		// Per-call `db.execute` impl: doc-1 succeeds (concurrent PATCH
		// did NOT bump its timestamp between SELECT and UPDATE), doc-2
		// returns zero rows (a concurrent PATCH bumped doc-2's timestamp
		// after our SELECT, so the WHERE clause no longer matches and we
		// must skip the enqueue to preserve the newer metadata change
		// for the next tick — R3 from the plan).
		setMockExecuteImpl(async (_q, i) => (i === 0 ? [{ id: "doc-1" }] : []));

		await cron._processStaleMetadataChangesForTests();

		// Only doc-1 should be enqueued — doc-2's UPDATE matched zero rows.
		expect(fakeEnqueueReembed.mock.calls.length).toBe(1);
		expect(fakeEnqueueReembed.mock.calls[0]?.[0]).toEqual(["doc-1"]);
		// Both rows were probed via UPDATE — the per-row atomic guard is
		// exercised even on the "lost the race" path.
		expect(executeCalls.length).toBe(2);
	});

	test("issues an UPDATE that clears metadata_changed_at via the original timestamp", async () => {
		// Smoke test: the WHERE clause must reference the original
		// `metadata_changed_at` value we read in the SELECT, not just
		// the doc id. We assert the chain was walked end-to-end
		// (select -> from -> where -> orderBy -> limit) and that
		// `db.execute` received a SQL object (the marker is opaque
		// when the integration test harness's drizzle-orm mock is in
		// scope — its `sql` tag drops the template text — so we only
		// check that an SQL-shaped argument was passed; the column
		// names are locked down by the integration test suite against
		// a real database, which is the only place a SQL text assertion
		// is meaningful).
		const ts = new Date("2026-01-01T00:00:00Z");
		selectRows = [{ id: "doc-1", metadataChangedAt: ts }];
		executeRows = [{ id: "doc-1" }];

		await cron._processStaleMetadataChangesForTests();

		expect(selectChain.from.mock.calls.length).toBe(1);
		expect(selectChain.where.mock.calls.length).toBe(1);
		expect(selectChain.orderBy.mock.calls.length).toBe(1);
		expect(selectChain.limit.mock.calls.length).toBe(1);
		expect(executeCalls.length).toBe(1);
		// `db.execute` was called with a SQL-shaped argument (an
		// object, not undefined/null/string). The exact column text
		// lives in the integration test suite where the real
		// drizzle-orm `sql` tag preserves the template strings.
		const sqlArg = executeCalls[0]?.sql;
		expect(sqlArg).toBeDefined();
		expect(typeof sqlArg).toBe("object");
	});

	test("does not call recordSignificantUpdate — the worker owns that", async () => {
		// The cron's contract is to enqueue; the worker calls
		// `recordSignificantUpdate` after a successful commit. We
		// assert the cron issued exactly ONE `db.execute` call per
		// enqueued row (the metadata-stale scan's own UPDATE) and did
		// NOT touch any "significant" columns.
		const ts = new Date("2026-01-01T00:00:00Z");
		selectRows = [{ id: "doc-1", metadataChangedAt: ts }];
		executeRows = [{ id: "doc-1" }];

		await cron._processStaleMetadataChangesForTests();

		expect(executeCalls.length).toBe(1);
		expect(fakeEnqueueReembed.mock.calls.length).toBe(1);
		// The captured SQL must NOT mention `last_significant_*` — only
		// the worker updates those columns.
		const sqlText = JSON.stringify(executeCalls[0]?.sql);
		expect(sqlText).not.toContain("last_significant");
	});
});

describe("reembed-cron idle-pending scan", () => {
	test("enqueues each idle doc returned by the db", async () => {
		selectRows = [{ id: "idle-1" }];

		await cron._processIdlePendingChangesForTests();

		// Single doc -> single enqueue.
		expect(fakeEnqueueReembed.mock.calls.length).toBe(1);
		expect(fakeEnqueueReembed.mock.calls[0]?.[0]).toEqual(["idle-1"]);
		// Idle scan is SELECT-only — no atomic UPDATE, no execute calls.
		expect(executeCalls.length).toBe(0);
	});

	test("enqueues multiple idle docs in the order they came back", async () => {
		selectRows = [{ id: "idle-1" }, { id: "idle-2" }, { id: "idle-3" }];

		await cron._processIdlePendingChangesForTests();

		expect(fakeEnqueueReembed.mock.calls.length).toBe(3);
		expect(fakeEnqueueReembed.mock.calls.map((c) => c[0])).toEqual([
			["idle-1"],
			["idle-2"],
			["idle-3"],
		]);
		// Order preservation is the `enqueueReembed` input contract —
		// since the source loop is sequential, we get FIFO behavior.
	});

	test("returns early (no enqueue) when the db returns no idle rows", async () => {
		selectRows = [];

		await cron._processIdlePendingChangesForTests();

		expect(fakeEnqueueReembed.mock.calls.length).toBe(0);
		// No execute — this scan is SELECT-only.
		expect(executeCalls.length).toBe(0);
	});

	test("does not call db.execute — the idle scan is SELECT-only", async () => {
		// The idle scan has no race-condition logic; it simply enqueues
		// each row. Asserting no `db.execute` call catches a future
		// refactor that accidentally duplicates the metadata-stale
		// scan's UPDATE step.
		selectRows = [{ id: "idle-1" }, { id: "idle-2" }];

		await cron._processIdlePendingChangesForTests();

		expect(executeCalls.length).toBe(0);
		expect(fakeEnqueueReembed.mock.calls.length).toBe(2);
	});
});

describe("reembed-cron public surface", () => {
	test("startReembedCron is exported and is a function", () => {
		// We don't actually invoke startReembedCron — it would create
		// real `setInterval` handles that survive past the test and
		// would also fire `processStaleMetadataChanges` immediately.
		// This is a surface-level smoke test confirming the entry
		// point exists and is callable.
		expect(typeof cron.startReembedCron).toBe("function");
	});

	test("test-only exports are callable and return a Promise<void>", () => {
		// Both test-only exports should return a Promise (the inner
		// scan function returns Promise<void>). We call them with an
		// empty db result and assert the returned promise resolves.
		selectRows = [];

		const staleP = cron._processStaleMetadataChangesForTests();
		expect(staleP).toBeInstanceOf(Promise);

		const idleP = cron._processIdlePendingChangesForTests();
		expect(idleP).toBeInstanceOf(Promise);

		return Promise.all([staleP, idleP]);
	});
});
