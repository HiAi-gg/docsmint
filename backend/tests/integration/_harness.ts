/**
 * Test harness for HTTP-level route tests.
 *
 * Strategy:
 * - Mock drizzle-orm conditions with marker Symbols so the in-memory DB
 *   can interpret `eq`, `and`, `or`, `isNull`, `desc`, `count` without
 *   touching a real Postgres connection.
 * - Mock the db, auth, redis, config, logger, embedding-queue, embedding,
 *   and webhook-verify modules BEFORE the routes are imported.
 * - Build a minimal Elysia app that mounts the route modules under test
 *   so we can call `app.handle(new Request(...))` for true HTTP-level tests.
 */

import { mock } from "bun:test";

export const API_KEY = "test-api-key-for-routes-32chars-xxx";
export const OWNER_ID = "00000000-0000-4000-8000-000000000001";
export const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
export const CSRF_SECRET = "test-csrf-secret-32-characters-long-xxxxx";
export const WEBHOOK_SECRET = "test-webhook-secret-32-chars-long-xx";

export interface TestState {
	users: Map<string, any>;
	folders: Map<string, any>;
	documents: Map<string, any>;
	tags: Map<string, any>;
	categories: Map<string, any>;
	documentTags: Array<{ documentId: string; tagId: string }>;
	shareLinks: Map<string, any>;
	guestAccess: any[];
	versions: any[];
	attachments: Map<string, any>;
	documentEmbeddings: any[];
	enqueuedEmbeddings: string[];
	calls: Array<{ kind: string; table: string }>;
}

function uuid4(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function createState(): TestState {
	const state: TestState = {
		users: new Map(),
		folders: new Map(),
		documents: new Map(),
		tags: new Map(),
		categories: new Map(),
		documentTags: [],
		shareLinks: new Map(),
		guestAccess: [],
		versions: [],
		attachments: new Map(),
		documentEmbeddings: [],
		enqueuedEmbeddings: [],
		calls: [],
	};
	state.users.set(OWNER_ID, {
		id: OWNER_ID,
		email: "[email protected]",
		name: "Owner",
		emailVerified: true,
	});
	state.users.set(OTHER_USER_ID, {
		id: OTHER_USER_ID,
		email: "[email protected]",
		name: "Other",
		emailVerified: true,
	});
	return state;
}

let state: TestState = createState();

export function getState(): TestState {
	return state;
}

export function resetState(): void {
	state = createState();
}

const TAG_EQ = Symbol("eq");
const TAG_AND = Symbol("and");
const TAG_OR = Symbol("or");
const TAG_IS_NULL = Symbol("isNull");
const TAG_IS_NOT_NULL = Symbol("isNotNull");
const TAG_IN_ARRAY = Symbol("inArray");
const TAG_DESC = Symbol("desc");
const TAG_ASC = Symbol("asc");
const TAG_SQL = Symbol("sql");
const TAG_COUNT = Symbol("count");
const TAG_LIKE = Symbol("like");
const TAG_NE = Symbol("ne");
const TAG_GT = Symbol("gt");
const TAG_LT = Symbol("lt");
const TAG_GTE = Symbol("gte");
const TAG_LTE = Symbol("lte");

const markEq = (col: any, val: any) => ({ [TAG_EQ]: true, col, val });
const markAnd = (...conds: any[]) => ({ [TAG_AND]: true, values: conds });
const markOr = (...conds: any[]) => ({ [TAG_OR]: true, values: conds });
const markIsNull = (col: any) => ({ [TAG_IS_NULL]: true, col });
const markIsNotNull = (col: any) => ({ [TAG_IS_NOT_NULL]: true, col });
const markInArray = (col: any, vals: any[]) => ({
	[TAG_IN_ARRAY]: true,
	col,
	vals,
});
const markDesc = (col: any) => ({ [TAG_DESC]: true, col });
const markAsc = (col: any) => ({ [TAG_ASC]: true, col });
const markCount = (col: any) => ({ [TAG_COUNT]: true, col });
const markLike = (col: any, pattern: any) => ({
	[TAG_LIKE]: true,
	col,
	pattern,
});
const markNe = (col: any, val: any) => ({ [TAG_NE]: true, col, val });
const markGt = (col: any, val: any) => ({ [TAG_GT]: true, col, val });
const markLt = (col: any, val: any) => ({ [TAG_LT]: true, col, val });
const markGte = (col: any, val: any) => ({ [TAG_GTE]: true, col, val });
const markLte = (col: any, val: any) => ({ [TAG_LTE]: true, col, val });

const sql: any = () => ({ [TAG_SQL]: true });
sql.raw = () => "RAW";

const OVERRIDES: Record<string, any> = {
	eq: markEq,
	and: markAnd,
	or: markOr,
	isNull: markIsNull,
	isNotNull: markIsNotNull,
	inArray: markInArray,
	desc: markDesc,
	asc: markAsc,
	count: markCount,
	like: markLike,
	ne: markNe,
	gt: markGt,
	lt: markLt,
	gte: markGte,
	lte: markLte,
	sql,
};

mock.module("drizzle-orm", () => {
	const real = require("drizzle-orm");
	return new Proxy(real, {
		get(target, prop) {
			if (typeof prop === "string" && prop in OVERRIDES) {
				return OVERRIDES[prop];
			}
			return target[prop];
		},
	});
});

function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function getColumnName(col: any): string {
	const snake = col?.name ?? "?";
	return snakeToCamel(snake);
}

function getTableName(table: any): string {
	if (table?._?.name) return table._.name;
	const syms = Object.getOwnPropertySymbols(table ?? {});
	for (const sym of syms) {
		const val = table[sym];
		if (typeof val === "string" && /^[a-z_]+$/.test(val)) return val;
	}
	return table?.name ?? "?";
}

function getCollection(name: string): any[] | Map<string, any> {
	switch (name) {
		case "users":
			return state.users;
		case "folders":
			return state.folders;
		case "documents":
			return state.documents;
		case "tags":
			return state.tags;
		case "categories":
			return state.categories;
		case "document_tags":
			return state.documentTags;
		case "share_links":
			return state.shareLinks;
		case "guest_access":
			return state.guestAccess;
		case "versions":
			return state.versions;
		case "attachments":
			return state.attachments;
		case "document_embeddings":
			return state.documentEmbeddings;
		default:
			throw new Error(`Unknown table in mock DB: ${name}`);
	}
}

function getRows(table: any): any[] {
	const col = getCollection(getTableName(table));
	if (col instanceof Map) return Array.from(col.values());
	return col as any[];
}

function evaluateCondition(row: any, cond: any): boolean {
	if (cond == null) return true;
	if (cond[TAG_EQ]) return row[getColumnName(cond.col)] === cond.val;
	if (cond[TAG_NE]) return row[getColumnName(cond.col)] !== cond.val;
	if (cond[TAG_GT]) return row[getColumnName(cond.col)] > cond.val;
	if (cond[TAG_LT]) return row[getColumnName(cond.col)] < cond.val;
	if (cond[TAG_GTE]) return row[getColumnName(cond.col)] >= cond.val;
	if (cond[TAG_LTE]) return row[getColumnName(cond.col)] <= cond.val;
	if (cond[TAG_AND]) return cond.values.every((c: any) => evaluateCondition(row, c));
	if (cond[TAG_OR]) return cond.values.some((c: any) => evaluateCondition(row, c));
	if (cond[TAG_IS_NULL]) return row[getColumnName(cond.col)] === null;
	if (cond[TAG_IS_NOT_NULL]) return row[getColumnName(cond.col)] !== null;
	if (cond[TAG_IN_ARRAY]) return cond.vals.includes(row[getColumnName(cond.col)]);
	if (cond[TAG_LIKE]) {
		const v = row[getColumnName(cond.col)];
		if (typeof v !== "string") return false;
		const pattern = String(cond.pattern).replace(/%/g, ".*");
		return new RegExp(`^${pattern}$`).test(v);
	}
	return true;
}

function applyFieldSelection(rows: any[], fields: any): any[] {
	if (!fields || typeof fields !== "object") return rows;
	const keys = Object.keys(fields);
	const aggregateKeys = keys.filter((k) => fields[k]?.[TAG_COUNT]);
	const columnKeys = keys.filter((k) => !aggregateKeys.includes(k));

	if (aggregateKeys.length === 0) {
		return rows.map((row) => {
			const out: any = {};
			for (const k of columnKeys) {
				out[k] = row[getColumnName(fields[k])];
			}
			return out;
		});
	}

	return rows.map((row) => {
		const out: any = {};
		for (const k of columnKeys) {
			out[k] = row[getColumnName(fields[k])];
		}
		for (const k of aggregateKeys) {
			if (row.id != null) {
				out[k] = state.documentTags.filter((dt) => dt.tagId === row.id).length;
			} else {
				out[k] = 0;
			}
		}
		return out;
	});
}

interface SelectCtx {
	type: "select";
	fields: any;
	from: any;
	joins: Array<{ type: string; table: any; cond: any }>;
	where: any;
	limit: number | null;
	offset: number | null;
	orderBy: any;
	groupBy: any[] | null;
}

function buildSelectProxy(ctx: SelectCtx): any {
	const handler: ProxyHandler<any> = {
		get(_target, prop) {
			if (prop === "then") {
				return (resolve: any, reject: any) => {
					try {
						return Promise.resolve(executeSelect(ctx)).then(resolve, reject);
					} catch (err) {
						return Promise.reject(err).then(reject, reject);
					}
				};
			}
			if (prop === "from")
				return (table: any) => {
					ctx.from = table;
					return buildSelectProxy(ctx);
				};
			if (prop === "where")
				return (cond: any) => {
					ctx.where = cond;
					return buildSelectProxy(ctx);
				};
			if (prop === "limit")
				return (n: number) => {
					ctx.limit = n;
					return buildSelectProxy(ctx);
				};
			if (prop === "offset")
				return (n: number) => {
					ctx.offset = n;
					return buildSelectProxy(ctx);
				};
			if (prop === "orderBy")
				return (col: any) => {
					ctx.orderBy = col;
					return buildSelectProxy(ctx);
				};
			if (prop === "groupBy")
				return (...cols: any[]) => {
					ctx.groupBy = cols;
					return buildSelectProxy(ctx);
				};
			if (prop === "leftJoin")
				return (table: any, cond: any) => {
					ctx.joins.push({ type: "left", table, cond });
					return buildSelectProxy(ctx);
				};
			if (prop === "innerJoin")
				return (table: any, cond: any) => {
					ctx.joins.push({ type: "inner", table, cond });
					return buildSelectProxy(ctx);
				};
			return undefined;
		},
	};
	return new Proxy({}, handler);
}

function executeSelect(ctx: SelectCtx): any[] {
	if (!ctx.from) return [];
	const tableName = getTableName(ctx.from);
	state.calls.push({ kind: "select", table: tableName });
	let rows = getRows(ctx.from);
	if (ctx.where) rows = rows.filter((r) => evaluateCondition(r, ctx.where));
	if (ctx.orderBy) {
		const isDesc = ctx.orderBy[TAG_DESC] === true;
		const colName = getColumnName(ctx.orderBy.col ?? ctx.orderBy);
		rows = [...rows].sort((a, b) => {
			const av = a[colName];
			const bv = b[colName];
			if (av === bv) return 0;
			if (av == null) return 1;
			if (bv == null) return -1;
			const cmp = av < bv ? -1 : 1;
			return isDesc ? -cmp : cmp;
		});
	}
	if (ctx.groupBy && ctx.groupBy.length > 0) {
		const seen = new Set<string>();
		const grouped: any[] = [];
		for (const row of rows) {
			const key = ctx.groupBy
				.map((g) => String(row[getColumnName(g)] ?? ""))
				.join("|");
			if (!seen.has(key)) {
				seen.add(key);
				grouped.push(row);
			}
		}
		rows = grouped;
	}
	if (ctx.offset != null) rows = rows.slice(ctx.offset);
	if (ctx.limit != null) rows = rows.slice(0, ctx.limit);
	return applyFieldSelection(rows, ctx.fields);
}

interface InsertCtx {
	type: "insert";
	table: any;
	values: any[];
}

function buildInsertProxy(ctx: InsertCtx): any {
	const handler: ProxyHandler<any> = {
		get(_target, prop) {
			if (prop === "values")
				return (v: any) => {
					ctx.values = Array.isArray(v) ? v : [v];
					return buildInsertProxy(ctx);
				};
			if (prop === "onConflictDoNothing")
				return buildInsertProxy(ctx);
			if (prop === "returning")
				return () => {
					state.calls.push({ kind: "insert", table: getTableName(ctx.table) });
					const tableName = getTableName(ctx.table);
					const collection = getCollection(tableName);
					const returned: any[] = [];
					for (const row of ctx.values) {
						const newRow: any = { ...row };
						if (newRow.id == null) newRow.id = uuid4();
						if (newRow.createdAt == null) newRow.createdAt = new Date();
						if (newRow.updatedAt == null) newRow.updatedAt = new Date();
						if (collection instanceof Map) {
							collection.set(newRow.id, newRow);
						} else {
							(collection as any[]).push(newRow);
						}
						returned.push(newRow);
					}
					return Promise.resolve(returned);
				};
			return undefined;
		},
	};
	return new Proxy({}, handler);
}

interface UpdateCtx {
	type: "update";
	table: any;
	set: any;
	where: any;
}

function buildUpdateProxy(ctx: UpdateCtx): any {
	const handler: ProxyHandler<any> = {
		get(_target, prop) {
			if (prop === "set")
				return (s: any) => {
					ctx.set = s;
					return buildUpdateProxy(ctx);
				};
			if (prop === "where")
				return (cond: any) => {
					ctx.where = cond;
					return buildUpdateProxy(ctx);
				};
			if (prop === "returning")
				return () => {
					state.calls.push({ kind: "update", table: getTableName(ctx.table) });
					const tableName = getTableName(ctx.table);
					const collection = getCollection(tableName);
					const returned: any[] = [];
					const rows =
						collection instanceof Map
							? Array.from(collection.values())
							: (collection as any[]);
					for (const row of rows) {
						if (!evaluateCondition(row, ctx.where)) continue;
						Object.assign(row, ctx.set);
						row.updatedAt = new Date();
						returned.push({ ...row });
					}
					return Promise.resolve(returned);
				};
			return undefined;
		},
	};
	return new Proxy({}, handler);
}

interface DeleteCtx {
	type: "delete";
	table: any;
	where: any;
}

function buildDeleteProxy(ctx: DeleteCtx): any {
	const handler: ProxyHandler<any> = {
		get(_target, prop) {
			if (prop === "where")
				return (cond: any) => {
					ctx.where = cond;
					return buildDeleteProxy(ctx);
				};
			if (prop === "returning")
				return () => {
					state.calls.push({ kind: "delete", table: getTableName(ctx.table) });
					const tableName = getTableName(ctx.table);
					const collection = getCollection(tableName);
					const returned: any[] = [];
					const items =
						collection instanceof Map
							? Array.from(collection.entries())
							: (collection as any[]).map((r, i) => [i, r]);
					const kept: any[] = [];
					for (const [, row] of items as Array<[any, any]>) {
						if (evaluateCondition(row, ctx.where)) {
							returned.push({ ...row });
						} else {
							kept.push(row);
						}
					}
					if (collection instanceof Map) {
						for (const r of returned) collection.delete(r.id);
					} else {
						(collection as any[]).length = 0;
						(collection as any[]).push(...kept);
					}
					return Promise.resolve(returned);
				};
			if (prop === "then")
				return (resolve: any, reject: any) => {
					try {
						state.calls.push({ kind: "delete", table: getTableName(ctx.table) });
						const tableName = getTableName(ctx.table);
						const collection = getCollection(tableName);
						const items =
							collection instanceof Map
								? Array.from(collection.entries())
								: (collection as any[]).map((r, i) => [i, r]);
						const kept: any[] = [];
						for (const [, row] of items as Array<[any, any]>) {
							if (!evaluateCondition(row, ctx.where)) kept.push(row);
						}
						if (collection instanceof Map) {
							for (const r of Array.from(collection.values())) {
								if (!kept.includes(r)) collection.delete(r.id);
							}
						} else {
							(collection as any[]).length = 0;
							(collection as any[]).push(...kept);
						}
						return Promise.resolve(undefined).then(resolve, reject);
					} catch (err) {
						return Promise.reject(err).then(reject, reject);
					}
				};
			return undefined;
		},
	};
	return new Proxy({}, handler);
}

function buildMockDb() {
	return {
		select(fields?: any) {
			const ctx: SelectCtx = {
				type: "select",
				fields,
				from: null,
				joins: [],
				where: null,
				limit: null,
				offset: null,
				orderBy: null,
				groupBy: null,
			};
			return buildSelectProxy(ctx);
		},
		insert(table: any) {
			return buildInsertProxy({ type: "insert", table, values: [] });
		},
		update(table: any) {
			return buildUpdateProxy({ type: "update", table, set: {}, where: null });
		},
		delete(table: any) {
			return buildDeleteProxy({ type: "delete", table, where: null });
		},
		execute(_sql: any) {
			return Promise.resolve([]);
		},
		transaction(fn: any) {
			return fn(this);
		},
	};
}

const mockDb = buildMockDb();

mock.module("../../src/lib/config.js", () => ({
	config: {
		API_KEY,
		HIAI_DOCS_API_KEY: API_KEY,
		OWNER_ID,
		CSRF_SECRET,
		WEBHOOK_SECRET,
		BETTER_AUTH_SECRET: "test-shared-secret-min-32-characters-long-x",
		BETTER_AUTH_URL: "http://localhost:50700",
		DATABASE_URL: "postgresql://test:test@localhost:5432/test",
		REDIS_URL: "redis://localhost:6379",
		EMBEDDING_BASE_URL: "http://localhost:11434",
		EMBEDDING_API_KEY: "",
		EMBEDDING_MODEL: "nomic-embed-text",
		EMBEDDING_FALLBACK_BASE_URL: "",
		EMBEDDING_FALLBACK_API_KEY: "",
		EMBEDDING_FALLBACK_MODEL: "",
		MINIO_ENDPOINT: "localhost",
		MINIO_PORT: 9000,
		MINIO_ACCESS_KEY: "minioadmin",
		MINIO_SECRET_KEY: "minioadmin",
		MINIO_BUCKET: "hiai-docs",
		MINIO_USE_SSL: false,
		API_PORT: 50700,
		FRONTEND_PORT: 50701,
		CORS_ORIGINS: undefined,
		NODE_ENV: "test",
		LOG_LEVEL: "fatal",
	},
}));

mock.module("../../src/lib/auth.js", () => ({
	auth: {
		api: {
			getSession: async () => null,
		},
		handler: async () =>
			new Response("auth handler not used in tests", { status: 500 }),
	},
	Session: undefined,
}));

mock.module("../../src/lib/db.js", () => ({
	db: mockDb,
	withTransaction: (fn: any) => fn(mockDb),
}));

mock.module("../../src/lib/redis.js", () => ({
	redis: {
		incr: async () => 1,
		expire: async () => 1,
		ttl: async () => 60,
		lpush: async () => 1,
		brpop: async () => null,
		get: async () => null,
		set: async () => "OK",
		del: async () => 1,
	},
	redisHealthCheck: async () => true,
}));

mock.module("../../src/lib/logger.js", () => ({
	logger: {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		fatal: () => {},
		trace: () => {},
	},
	createChildLogger: () => ({
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	}),
}));

mock.module("../../src/lib/minio.js", () => ({
	minio: {
		putObject: async () => "etag",
		removeObject: async () => {},
	},
	BUCKET: "hiai-docs",
}));

mock.module("../../src/lib/embedding-queue.js", () => ({
	enqueueEmbedding: (id: string) => {
		state.enqueuedEmbeddings.push(id);
	},
	startEmbeddingWorker: () => {},
}));

// Mock only the network-calling embedding helpers. The pure utilities
// (`buildMetadataPreamble`, `EmbeddingMetadata`) are deliberately left
// un-mocked so unit tests in `src/__tests__/embedding-metadata.test.ts`
// can import them through this path when run alongside the integration
// suite. Without this carve-out the static import would resolve to the
// stub below and the unit test would fail with "Export named
// 'buildMetadataPreamble' not found".
const REAL_EMBEDDING_MODULE = await import("../../src/embedding/index");
mock.module("../../src/embedding/index.js", () => ({
	getEmbedding: async () => new Array(1024).fill(0),
	embedDocument: async () => [new Array(1024).fill(0)],
	// Forward real exports so any test that pulls them through this mock
	// path still gets the genuine implementation.
	buildMetadataPreamble: REAL_EMBEDDING_MODULE.buildMetadataPreamble,
	EmbeddingMetadata: REAL_EMBEDDING_MODULE.EmbeddingMetadata,
}));

mock.module("../../src/api/middleware/webhook-verify.js", () => ({
	verifyWebhookSignature: (body: string, sig: string | null) => {
		if (!sig) return false;
		return /^[a-f0-9]{64}$/i.test(sig);
	},
}));

export interface BuiltApp {
	app: any;
	csrfToken: string;
}

let cachedApp: BuiltApp | null = null;

export async function setupHarness(): Promise<BuiltApp> {
	if (cachedApp) return cachedApp;

	const { Elysia } = await import("elysia");
	const { csrfMiddleware } = await import("../../src/api/middleware/csrf");
	const { authMiddleware } = await import("../../src/api/middleware/auth");
	const { folderRoutes } = await import("../../src/api/routes/folders");
	const { tagRoutes } = await import("../../src/api/routes/tags");
	const { searchRoutes } = await import("../../src/api/routes/search");
	const { shareRoutes } = await import("../../src/api/routes/share");
	const { documentRoutes } = await import("../../src/api/routes/documents");
	const { versionRoutes } = await import("../../src/api/routes/versions");
	const { webhookRoutes } = await import("../../src/api/routes/webhooks");
	const { categoryRoutes } = await import("../../src/api/routes/categories");

	const app = new Elysia()
		.use(csrfMiddleware)
		.use(authMiddleware)
		.use(folderRoutes)
		.use(tagRoutes)
		.use(shareRoutes)
		.use(searchRoutes)
		.use(documentRoutes)
		.use(versionRoutes)
		.use(webhookRoutes)
		.use(categoryRoutes);

	const { createHmac, randomBytes } = await import("node:crypto");
	function signToken(token: string): string {
		return createHmac("sha256", CSRF_SECRET).update(token).digest("hex");
	}
	const raw = randomBytes(32).toString("hex");
	const csrfToken = `${raw}.${signToken(raw)}`;

	cachedApp = { app, csrfToken };
	return cachedApp;
}

export interface ApiResponse<T = any> {
	status: number;
	body: T;
	headers: Headers;
	raw: Response;
}

export async function request<T = any>(
	app: any,
	path: string,
	init: RequestInit = {},
): Promise<ApiResponse<T>> {
	const req = new Request(`http://localhost${path}`, init);
	const res = await app.handle(req);
	const text = await res.text();
	let body: T;
	try {
		body = text ? (JSON.parse(text) as T) : (undefined as T);
	} catch {
		body = text as unknown as T;
	}
	return { status: res.status, body, headers: res.headers, raw: res };
}

export function ownerHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		authorization: `Bearer ${API_KEY}`,
		"content-type": "application/json",
		...extra,
	};
}

export function noAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"content-type": "application/json",
		...extra,
	};
}
