import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	DeleteObjectCommand,
	HeadObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
	DocsApiError,
	DocsClient,
	createDocsmintWorkspaceAssertion,
	type WorkspaceResourcePermission,
} from "@hiai-docs/sdk";
import {
	createDatabaseClient,
	type DatabaseQueryObservation,
} from "../../../db/src/client";
import {
	type TenantContext,
	withTenantDatabase,
} from "../../../db/src/with-tenant";
import type { SQL } from "drizzle-orm";
import Redis from "ioredis";
import postgres from "postgres";

import { launchDocsMintApi } from "../../../sdk/dist/backend-launcher.js";
import { retrieveGraphCandidates } from "../../../../backend/src/search/graph-retriever";
import { searchDocuments } from "../../../../backend/src/search/orchestrator";
import { retrieveFastChannels } from "../../../../backend/src/search/retrievers";
import { tenantTopologyLockKey } from "../../../../backend/src/lib/topology-serialization";
import { capabilityCatalog } from "../../src/capabilities.js";
import { createDocsmintMcpServer } from "../../src/server.js";
import { resolveContractServiceBindings } from "./contract-service-bindings";

const requiredEnvironment = [
	"DOCSMINT_WORKSPACE_SECRET",
	"DOCSMINT_WORKSPACE_ISSUER",
	"HIAI_DOCS_API_KEY",
	"DOCSMINT_CONTRACT_EMBEDDING_URL",
	"EMBEDDING_BASE_URL",
	"STORAGE_ACCESS_KEY",
	"STORAGE_SECRET_KEY",
	"STORAGE_BUCKET",
] as const;

function requiredEnvironmentValue(
	name: (typeof requiredEnvironment)[number],
): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for the live contract suite`);
	return value;
}

for (const name of requiredEnvironment) requiredEnvironmentValue(name);

const bindings = resolveContractServiceBindings(process.env);
const { databaseUrl, baseUrl, redisUrl, storageUrl } = bindings;
const workspaceSecret = requiredEnvironmentValue("DOCSMINT_WORKSPACE_SECRET");
const workspaceIssuer = requiredEnvironmentValue("DOCSMINT_WORKSPACE_ISSUER");
const serviceApiKey = requiredEnvironmentValue("HIAI_DOCS_API_KEY");
const storageBucket = requiredEnvironmentValue("STORAGE_BUCKET");
const embeddingUrl = requiredEnvironmentValue(
	"DOCSMINT_CONTRACT_EMBEDDING_URL",
).replace(/\/$/, "");
if (
	new URL(embeddingUrl).href !==
	new URL(requiredEnvironmentValue("EMBEDDING_BASE_URL")).href
) {
	throw new Error(
		"Live contract service binding mismatch: embedding fixture and runtime URLs differ",
	);
}

const embeddingModel = "task2-contract-embedding";
const embeddingProfile = `${embeddingModel}:1024:v1`;
const embeddingVector = [1, ...Array.from({ length: 1023 }, () => 0)];
const embeddingVectorLiteral = `[${embeddingVector.join(",")}]`;

const suffix = crypto.randomUUID();
const ids = {
	actorA: crypto.randomUUID(),
	actorB: crypto.randomUUID(),
	categoryA: crypto.randomUUID(),
	categoryOther: crypto.randomUUID(),
	categoryForeign: crypto.randomUUID(),
	folderRootA: crypto.randomUUID(),
	folderNestedA: crypto.randomUUID(),
	folderOther: crypto.randomUUID(),
	folderForeign: crypto.randomUUID(),
	docDirectA: crypto.randomUUID(),
	docNestedA: crypto.randomUUID(),
	docPageA1: crypto.randomUUID(),
	docPageA2: crypto.randomUUID(),
	docOther: crypto.randomUUID(),
	docForeign: crypto.randomUUID(),
	docDeleted: crypto.randomUUID(),
	docPersonalVisible: crypto.randomUUID(),
	docPersonalDeleted: crypto.randomUUID(),
	docCacheProbe: crypto.randomUUID(),
	personalApiKey: crypto.randomUUID(),
	tagA: crypto.randomUUID(),
	tagOther: crypto.randomUUID(),
	tagForeign: crypto.randomUUID(),
	versionA: crypto.randomUUID(),
	snapshotA: crypto.randomUUID(),
	generationDirect: crypto.randomUUID(),
	generationNested: crypto.randomUUID(),
	generationForeign: crypto.randomUUID(),
	generationOther: crypto.randomUUID(),
	generationDeleted: crypto.randomUUID(),
	pipelineRun: crypto.randomUUID(),
} as const;

const workspaceA = `task2-workspace-a-${suffix}`;
const workspaceB = `task2-workspace-b-${suffix}`;
const lexicalNeedle = `scopealpha${suffix.replaceAll("-", "")}`;
const graphEntity = `ContractEntity${suffix.replaceAll("-", "")}`;
const personalVisibleTitle = `Personal visible ${suffix}`;
const personalDeletedTitle = `Personal deleted ${suffix}`;
const database = postgres(databaseUrl, { max: 2 });
const queryObservations: DatabaseQueryObservation[] = [];
const observedDatabase = createDatabaseClient(databaseUrl, {
	max: 4,
	queryObserver: (observation) => queryObservations.push(observation),
});
const contractRedis = new Redis(redisUrl, {
	lazyConnect: true,
	maxRetriesPerRequest: 1,
});
const contractStorage = new S3Client({
	endpoint: storageUrl,
	region: process.env.STORAGE_REGION?.trim() || "us-east-1",
	credentials: {
		accessKeyId: requiredEnvironmentValue("STORAGE_ACCESS_KEY"),
		secretAccessKey: requiredEnvironmentValue("STORAGE_SECRET_KEY"),
	},
	forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== "false",
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
});
const orphanedObjectKeys = new Set<string>();

let apiHandle: Awaited<ReturnType<typeof launchDocsMintApi>> | undefined;
let mcpClient: Client | undefined;
let closeMcp: (() => Promise<void>) | undefined;
let embeddingServer: { stop(closeActiveConnections?: boolean): void } | undefined;
let embeddingRequests = 0;

type Deferred<T> = Readonly<{
	promise: Promise<T>;
	resolve: (value: T) => void;
}>;

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function deleteContractObject(key: string): Promise<void> {
	await contractStorage.send(
		new DeleteObjectCommand({ Bucket: storageBucket, Key: key }),
	);
}

async function contractObjectExists(key: string): Promise<boolean> {
	try {
		await contractStorage.send(
			new HeadObjectCommand({ Bucket: storageBucket, Key: key }),
		);
		return true;
	} catch (error) {
		const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
			?.httpStatusCode;
		if (status === 404) return false;
		throw error;
	}
}

async function cleanupContractUpload(
	docs: DocsClient,
	objectKey: string | undefined,
	attachmentId: string | undefined,
): Promise<void> {
	if (attachmentId) {
		await docs.deleteAttachment(attachmentId);
	} else if (objectKey) {
		await deleteContractObject(objectKey);
	}
	if (objectKey) orphanedObjectKeys.delete(objectKey);
}

afterEach(async () => {
	for (const key of orphanedObjectKeys) {
		try {
			await deleteContractObject(key);
		} finally {
			orphanedObjectKeys.delete(key);
		}
	}
});

function assertionPayload(
	workspaceId: string,
	actorUserId: string,
	permissions?: readonly WorkspaceResourcePermission[],
	categoryId = ids.categoryA,
) {
	const now = Math.floor(Date.now() / 1000);
	return {
		actorUserId,
		workspaceId,
		actorRole: "owner" as const,
		...(permissions
			? {
					resourceScope: {
						kind: "category" as const,
						categoryId,
						permissions,
					},
			}
			: {}),
		issuedAt: now,
		expiresAt: now + 60,
		issuer: workspaceIssuer,
	};
}

async function createAssertion(
	permissions?: readonly WorkspaceResourcePermission[],
) {
	return createDocsmintWorkspaceAssertion(
		assertionPayload(workspaceA, ids.actorA, permissions),
		workspaceSecret,
	);
}

function toBase64Url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

async function signUncheckedPayload(payload: Record<string, unknown>) {
	const encoded = toBase64Url(JSON.stringify(payload));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(workspaceSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = Buffer.from(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(encoded),
		),
	).toString("base64url");
	return `${encoded}.${signature}`;
}

async function requestWithAssertion(
	path: string,
	assertion: string,
	init: RequestInit = {},
) {
	const headers = new Headers(init.headers);
	headers.set("x-docsmint-workspace-context", assertion);
	return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function waitForHealthyApi(): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/api/health`);
			if (response.ok) return;
		} catch {
			// The listener may not be bound during the first poll.
		}
		await Bun.sleep(100);
	}
	throw new Error("Live DocsMint API did not become healthy within 20 seconds");
}

async function waitForTopologyLockWait(blockerPid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const [row] = await database<{ waiting: number }[]>`
			SELECT count(*)::int AS waiting
			FROM pg_locks waiting
			WHERE waiting.locktype = 'advisory'
				AND NOT waiting.granted
				AND ${blockerPid} = ANY(pg_blocking_pids(waiting.pid))`;
		if ((row?.waiting ?? 0) > 0) return true;
		await Bun.sleep(10);
	}
	return false;
}

function graphQuery(cypher: string, columns = "result agtype") {
	let tag = "task2";
	while (cypher.includes(`$${tag}$`)) tag = `${tag}_x`;
	return `SELECT * FROM cypher('docs_graph', $${tag}$ ${cypher} $${tag}$) AS (${columns})`;
}

async function seedFixtures(): Promise<void> {
	await database`INSERT INTO users (id, email, name, email_verified)
		VALUES
			(${ids.actorA}::uuid, ${`task2-a-${suffix}@example.test`}, 'Task 2 Actor A', true),
			(${ids.actorB}::uuid, ${`task2-b-${suffix}@example.test`}, 'Task 2 Actor B', true)`;
	await database`INSERT INTO categories (id, owner_id, workspace_id, name, "order")
		VALUES
			(${ids.categoryA}::uuid, ${ids.actorA}::uuid, ${workspaceA}, 'Scoped category', 1),
			(${ids.categoryOther}::uuid, ${ids.actorA}::uuid, ${workspaceA}, 'Other category', 2),
			(${ids.categoryForeign}::uuid, ${ids.actorB}::uuid, ${workspaceB}, 'Foreign category', 1)`;
	const personalApiKeyHash = new Bun.CryptoHasher("sha256")
		.update(ids.personalApiKey)
		.digest("hex");
	await database`INSERT INTO api_keys
		(owner_id, name, key_hash, prefix, scopes)
		VALUES (${ids.actorA}::uuid, 'Task 2 personal suggest key', ${personalApiKeyHash}, ${ids.personalApiKey.slice(0, 8)}, '["global"]'::jsonb)`;
	await database`INSERT INTO folders (id, owner_id, workspace_id, parent_id, category_id, name, "order")
		VALUES
			(${ids.folderRootA}::uuid, ${ids.actorA}::uuid, ${workspaceA}, NULL, ${ids.categoryA}::uuid, 'Scoped root', 1),
			(${ids.folderNestedA}::uuid, ${ids.actorA}::uuid, ${workspaceA}, ${ids.folderRootA}::uuid, NULL, 'Scoped nested', 1),
			(${ids.folderOther}::uuid, ${ids.actorA}::uuid, ${workspaceA}, NULL, ${ids.categoryOther}::uuid, 'Other root', 2),
			(${ids.folderForeign}::uuid, ${ids.actorB}::uuid, ${workspaceB}, NULL, ${ids.categoryForeign}::uuid, 'Foreign root', 1)`;

	const insertedAt = [
		[ids.docDirectA, ids.actorA, workspaceA, null, ids.categoryA, "Scoped direct", `${lexicalNeedle} direct`, null, "2026-08-24T08:00:00Z", ids.generationDirect],
		[ids.docNestedA, ids.actorA, workspaceA, ids.folderNestedA, null, "Scoped nested", "graph neighbor body", null, "2026-08-24T08:01:00Z", ids.generationNested],
		[ids.docPageA1, ids.actorA, workspaceA, ids.folderNestedA, null, "Scoped page one", `${lexicalNeedle} page one`, null, "2026-08-24T08:02:00Z", null],
		[ids.docPageA2, ids.actorA, workspaceA, null, ids.categoryA, "Scoped page two", `${lexicalNeedle} page two`, null, "2026-08-24T08:03:00Z", null],
		[ids.docOther, ids.actorA, workspaceA, ids.folderOther, null, "Other category", `${lexicalNeedle} other`, null, "2026-08-24T08:04:00Z", ids.generationOther],
		[ids.docForeign, ids.actorB, workspaceB, ids.folderForeign, null, "Foreign workspace", `${lexicalNeedle} foreign`, null, "2026-08-24T08:05:00Z", ids.generationForeign],
		[ids.docDeleted, ids.actorA, workspaceA, null, ids.categoryA, "Deleted scoped", `${lexicalNeedle} deleted`, "2026-08-24T09:00:00Z", "2026-08-24T08:06:00Z", ids.generationDeleted],
		[ids.docCacheProbe, ids.actorA, workspaceA, null, ids.categoryOther, "Negative cache probe", "moves after the first miss", null, "2026-08-24T08:07:00Z", null],
	] as const;
	for (const row of insertedAt) {
		await database`INSERT INTO documents
			(id, owner_id, workspace_id, folder_id, category_id, title, content, deleted_at, created_at, updated_at, embedding_status, active_embedding_generation, embedding_profile)
			VALUES (${row[0]}::uuid, ${row[1]}::uuid, ${row[2]}, ${row[3]}::uuid, ${row[4]}::uuid, ${row[5]}, ${row[6]}, ${row[7]}::timestamptz, ${row[8]}::timestamptz, ${row[8]}::timestamptz, 'ready', ${row[9]}::uuid, ${embeddingProfile})`;
	}
	await database`INSERT INTO documents
		(id, owner_id, workspace_id, folder_id, category_id, title, content, deleted_at, created_at, updated_at)
		VALUES
			(${ids.docPersonalVisible}::uuid, ${ids.actorA}::uuid, NULL, NULL, NULL, ${personalVisibleTitle}, 'personal visible', NULL, '2026-08-24T08:08:00Z', '2026-08-24T08:08:00Z'),
			(${ids.docPersonalDeleted}::uuid, ${ids.actorA}::uuid, NULL, NULL, NULL, ${personalDeletedTitle}, 'personal deleted', '2026-08-24T09:00:00Z', '2026-08-24T08:09:00Z', '2026-08-24T08:09:00Z')`;

	await database`INSERT INTO tags (id, owner_id, workspace_id, name, color)
		VALUES
			(${ids.tagA}::uuid, ${ids.actorA}::uuid, ${workspaceA}, 'Scoped tag', '#111111'),
			(${ids.tagOther}::uuid, ${ids.actorA}::uuid, ${workspaceA}, 'Other tag', '#222222'),
			(${ids.tagForeign}::uuid, ${ids.actorB}::uuid, ${workspaceB}, 'Foreign tag', '#333333')`;
	await database`INSERT INTO document_tags (workspace_id, document_id, tag_id)
		VALUES
			(${workspaceA}, ${ids.docDirectA}::uuid, ${ids.tagA}::uuid),
			(${workspaceA}, ${ids.docNestedA}::uuid, ${ids.tagA}::uuid),
			(${workspaceA}, ${ids.docOther}::uuid, ${ids.tagOther}::uuid),
			(${workspaceB}, ${ids.docForeign}::uuid, ${ids.tagForeign}::uuid)`;
	await database`INSERT INTO versions
		(id, document_id, workspace_id, content, created_by, created_at, label, is_snapshot)
		VALUES
			(${ids.versionA}::uuid, ${ids.docDirectA}::uuid, ${workspaceA}, 'initial version', ${ids.actorA}::uuid, '2026-08-24T08:00:00Z', NULL, false),
			(${ids.snapshotA}::uuid, ${ids.docDirectA}::uuid, ${workspaceA}, 'snapshot version', ${ids.actorA}::uuid, '2026-08-24T08:30:00Z', 'fixture snapshot', true)`;
	await database`INSERT INTO document_pipeline_runs
		(id, document_id, owner_id, workspace_id, generation_id, revision, source, refresh_mode, status, prepare_status, embed_status, graph_status, summarize_status, finalize_status, total_batches, completed_batches, failed_batches)
		VALUES (${ids.pipelineRun}::uuid, ${ids.docDirectA}::uuid, ${ids.actorA}::uuid, ${workspaceA}, ${ids.generationDirect}::uuid, 'fixture-revision', 'contract', 'full', 'ready', 'ready', 'ready', 'ready', 'ready', 'ready', 1, 1, 0)`;
	for (const [documentId, workspaceId, generationId] of [
		[ids.docDirectA, workspaceA, ids.generationDirect],
		[ids.docOther, workspaceA, ids.generationOther],
		[ids.docForeign, workspaceB, ids.generationForeign],
		[ids.docDeleted, workspaceA, ids.generationDeleted],
	] as const) {
		await database`INSERT INTO document_embeddings
			(document_id, workspace_id, chunk_index, chunk_text, generation_id, embedding, embedding_model, embedding_dimensions, embedding_profile, is_valid)
			VALUES (${documentId}::uuid, ${workspaceId}, 0, 'fixture vector chunk', ${generationId}::uuid, ${embeddingVectorLiteral}::vector, ${embeddingModel}, 1024, ${embeddingProfile}, true)`;
	}

	await database.unsafe("LOAD 'age'");
	await database.unsafe("SET search_path = ag_catalog, public");
	await database.unsafe(
		graphQuery(`
			MERGE (direct:Document {id: ${JSON.stringify(ids.docDirectA)}})
			SET direct.generation_id = ${JSON.stringify(ids.generationDirect)}
			MERGE (nested:Document {id: ${JSON.stringify(ids.docNestedA)}})
			SET nested.generation_id = ${JSON.stringify(ids.generationNested)}
			MERGE (foreign:Document {id: ${JSON.stringify(ids.docForeign)}})
			SET foreign.generation_id = ${JSON.stringify(ids.generationForeign)}
			MERGE (entity:Concept {name: ${JSON.stringify(graphEntity)}})
			MERGE (direct)-[:MENTIONS]->(entity)
			MERGE (nested)-[:MENTIONS]->(entity)
			MERGE (foreign)-[:MENTIONS]->(entity)
			RETURN 1
		`),
	);
}

async function cleanupFixtures(): Promise<void> {
	try {
		await database.unsafe("LOAD 'age'");
		await database.unsafe("SET search_path = ag_catalog, public");
		await database.unsafe(
			graphQuery(`
				MATCH (document:Document)
				WHERE document.id IN [${[ids.docDirectA, ids.docNestedA, ids.docForeign]
					.map((id) => JSON.stringify(id))
					.join(", ")}]
				DETACH DELETE document
				RETURN 1
			`),
		);
		await database.unsafe(
			graphQuery(`MATCH (entity:Concept {name: ${JSON.stringify(graphEntity)}}) DETACH DELETE entity RETURN 1`),
		);
	} finally {
		await database`DELETE FROM users WHERE id IN (${ids.actorA}::uuid, ${ids.actorB}::uuid)`;
	}
}

beforeAll(async () => {
	const embeddingEndpoint = new URL(embeddingUrl);
	if (
		!['127.0.0.1', 'localhost'].includes(embeddingEndpoint.hostname) ||
		!embeddingEndpoint.port
	) {
		throw new Error(
			"DOCSMINT_CONTRACT_EMBEDDING_URL must use an explicit loopback port",
		);
	}
	embeddingServer = Bun.serve({
		hostname: embeddingEndpoint.hostname,
		port: Number(embeddingEndpoint.port),
		fetch(request) {
			if (
				request.method !== "POST" ||
				new URL(request.url).pathname !== `${embeddingEndpoint.pathname.replace(/\/$/, "")}/embeddings`
			) {
				return new Response("Not found", { status: 404 });
			}
			embeddingRequests += 1;
			return Response.json({ data: [{ embedding: embeddingVector }] });
		},
	});
	await contractRedis.connect();
	await cleanupFixtures().catch(() => undefined);
	await seedFixtures();
	apiHandle = await launchDocsMintApi({
		attachmentStorageQuotaAdmission: {
			reserve: async (context) => ({ id: `contract-${context.requestId}` }),
			finalize: async () => undefined,
			releaseReservation: async () => undefined,
			releaseCommitted: async () => undefined,
		},
	});
	await apiHandle.ready;
	await waitForHealthyApi();
});

afterAll(async () => {
	await closeMcp?.();
	await Bun.sleep(100);
	await apiHandle?.stop();
	await cleanupFixtures();
	await database.end();
	await observedDatabase.client.end();
	await contractRedis.quit();
	contractStorage.destroy();
	embeddingServer?.stop(true);
});

describe("live category-scoped public surfaces", () => {
	test("excludes soft-deleted suggestions for personal, legacy workspace, and category assertions", async () => {
		const personal = new DocsClient({
			baseUrl,
			apiKey: ids.personalApiKey,
			retries: 1,
		});
		const personalVisible = await personal.suggest(personalVisibleTitle);
		const personalDeleted = await personal.suggest(personalDeletedTitle);
		expect(personalVisible.map(({ id }) => id)).toContain(ids.docPersonalVisible);
		expect(personalDeleted.map(({ id }) => id)).not.toContain(
			ids.docPersonalDeleted,
		);

		const legacy = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: { workspaceAssertion: await createAssertion() },
		});
		const scoped = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: {
				workspaceAssertion: await createAssertion(["read"]),
			},
		});
		for (const client of [legacy, scoped]) {
			const suggestions = await client.suggest("Deleted scoped");
			expect(suggestions.map(({ id }) => id)).not.toContain(ids.docDeleted);
		}
	});

	test("enforces assertion status and independent permission behavior through REST", async () => {
		const readAssertion = await createAssertion(["read"]);
		const editAssertion = await createAssertion(["edit"]);
		const writeAssertion = await createAssertion(["write"]);
		const combinedAssertion = await createAssertion(["read", "edit", "write"]);
		const legacyAssertion = await createAssertion();

		const legacyCategories = await requestWithAssertion(
			"/api/categories",
			legacyAssertion,
		);
		expect(legacyCategories.status).toBe(200);
		expect(
			(await legacyCategories.json() as Array<{ id: string }>).map(({ id }) => id),
		).toEqual([ids.categoryA, ids.categoryOther]);

		const scopedCategories = await requestWithAssertion(
			"/api/categories",
			readAssertion,
		);
		expect(scopedCategories.status).toBe(200);
		expect(await scopedCategories.json()).toMatchObject([
			{ id: ids.categoryA, documentCount: 4, folderCount: 2 },
		]);

		for (const documentId of [ids.docOther, ids.docForeign, ids.docDeleted]) {
			expect(
				(await requestWithAssertion(
					`/api/documents/${documentId}`,
					readAssertion,
				)).status,
			).toBe(404);
		}

		expect(
			(await requestWithAssertion(`/api/documents/${ids.docDirectA}`, writeAssertion)).status,
		).toBe(403);
		expect(
			(await requestWithAssertion(
				`/api/documents/${ids.docDirectA}`,
				readAssertion,
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ title: "read cannot edit" }),
				},
			)).status,
		).toBe(403);
		expect(
			(await requestWithAssertion(
				`/api/documents/${ids.docDirectA}/index/refresh`,
				editAssertion,
				{ method: "POST" },
			)).status,
		).toBe(403);
		expect(
			(await requestWithAssertion(
				`/api/documents/${ids.docDirectA}/index-status`,
				combinedAssertion,
			)).status,
		).toBe(200);

		const [encodedPayload, encodedSignature] = combinedAssertion.split(".");
		if (!encodedPayload || !encodedSignature) {
			throw new Error("Fixture assertion did not contain payload and signature");
		}
		const tampered = `${encodedPayload}.${encodedSignature.startsWith("A") ? "B" : "A"}${encodedSignature.slice(1)}`;
		const unknown = await signUncheckedPayload({
			...assertionPayload(workspaceA, ids.actorA, ["read"]),
			unknown: true,
		});
		const now = Math.floor(Date.now() / 1000);
		const expired = await createDocsmintWorkspaceAssertion(
			{
				...assertionPayload(workspaceA, ids.actorA, ["read"]),
				issuedAt: now - 120,
				expiresAt: now - 60,
			},
			workspaceSecret,
		);
		for (const [kind, assertion] of [
			["malformed", "malformed"],
			["tampered", tampered],
			["unknown", unknown],
			["expired", expired],
		] as const) {
			expect(
				(await requestWithAssertion("/api/categories", assertion)).status,
				kind,
			).toBe(401);
		}
	});

	test("serializes attached create category resolution behind topology mutation", async () => {
		const folderId = crypto.randomUUID();
		const title = `create topology race ${crypto.randomUUID()}`;
		const assertion = await createAssertion(["read", "edit", "write"]);
		const ready = deferred<void>();
		const release = deferred<void>();
		const key = tenantTopologyLockKey({
			userId: ids.actorA,
			role: "user",
			source: "external",
			workspaceId: workspaceA,
		});
		let mutationTask: Promise<unknown> | undefined;
		let blockerPid: number | undefined;
		try {
			await database`INSERT INTO folders
				(id, owner_id, workspace_id, category_id, name)
				VALUES (${folderId}::uuid, ${ids.actorA}::uuid, ${workspaceA}, ${ids.categoryA}::uuid, 'create race')`;
			mutationTask = database.begin(async (tx) => {
				const [connection] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
				blockerPid = connection?.pid;
				await tx`SELECT pg_advisory_xact_lock(${key})`;
				await tx`UPDATE folders SET category_id = ${ids.categoryOther}::uuid
					WHERE id = ${folderId}::uuid`;
				ready.resolve(undefined);
				await release.promise;
			});
			await ready.promise;
			const responsePromise = requestWithAssertion(
				"/api/documents",
				assertion,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${serviceApiKey}`,
						"content-type": "application/json",
						"x-forwarded-for": "198.51.100.41",
					},
					body: JSON.stringify({ title, folderId }),
				},
			);
			let blocked = false;
			try {
				if (!blockerPid) throw new Error("Missing topology blocker PID");
				blocked = await waitForTopologyLockWait(blockerPid);
			} finally {
				release.resolve(undefined);
			}
			const response = await responsePromise;
			await mutationTask;
			expect(response.status).toBe(403);
			expect(blocked).toBe(true);
			const rows = await database<{ count: number }[]>`SELECT count(*)::int AS count
				FROM documents WHERE title = ${title}`;
			expect(rows[0]?.count).toBe(0);
		} finally {
			release.resolve(undefined);
			await mutationTask?.catch(() => undefined);
			await database`DELETE FROM documents WHERE title = ${title}`;
			await database`DELETE FROM folders WHERE id = ${folderId}::uuid`;
		}
	});

	test("serializes attached import category resolution behind topology mutation", async () => {
		const folderId = crypto.randomUUID();
		const title = `import topology race ${crypto.randomUUID()}`;
		const assertion = await createAssertion(["read", "edit", "write"]);
		const ready = deferred<void>();
		const release = deferred<void>();
		const key = tenantTopologyLockKey({
			userId: ids.actorA,
			role: "user",
			source: "external",
			workspaceId: workspaceA,
		});
		let mutationTask: Promise<unknown> | undefined;
		let blockerPid: number | undefined;
		try {
			await database`INSERT INTO folders
				(id, owner_id, workspace_id, category_id, name)
				VALUES (${folderId}::uuid, ${ids.actorA}::uuid, ${workspaceA}, ${ids.categoryA}::uuid, 'import race')`;
			mutationTask = database.begin(async (tx) => {
				const [connection] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
				blockerPid = connection?.pid;
				await tx`SELECT pg_advisory_xact_lock(${key})`;
				await tx`UPDATE folders SET category_id = ${ids.categoryOther}::uuid
					WHERE id = ${folderId}::uuid`;
				ready.resolve(undefined);
				await release.promise;
			});
			await ready.promise;
			const responsePromise = requestWithAssertion(
				"/api/documents/import",
				assertion,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${serviceApiKey}`,
						"content-type": "application/json",
						"x-forwarded-for": "198.51.100.42",
					},
					body: JSON.stringify({ title, content: "race", folderId }),
				},
			);
			let blocked = false;
			try {
				if (!blockerPid) throw new Error("Missing topology blocker PID");
				blocked = await waitForTopologyLockWait(blockerPid);
			} finally {
				release.resolve(undefined);
			}
			const response = await responsePromise;
			await mutationTask;
			expect(response.status).toBe(403);
			expect(blocked).toBe(true);
			const rows = await database<{ count: number }[]>`SELECT count(*)::int AS count
				FROM documents WHERE title = ${title}`;
			expect(rows[0]?.count).toBe(0);
		} finally {
			release.resolve(undefined);
			await mutationTask?.catch(() => undefined);
			await database`DELETE FROM documents WHERE title = ${title}`;
			await database`DELETE FROM folders WHERE id = ${folderId}::uuid`;
		}
	});

	test("serializes duplicate source placement reads behind topology mutation", async () => {
		const sourceId = crypto.randomUUID();
		const title = `duplicate topology race ${crypto.randomUUID()}`;
		const assertion = await createAssertion(["read", "edit", "write"]);
		const ready = deferred<void>();
		const release = deferred<void>();
		const key = tenantTopologyLockKey({
			userId: ids.actorA,
			role: "user",
			source: "external",
			workspaceId: workspaceA,
		});
		let mutationTask: Promise<unknown> | undefined;
		let blockerPid: number | undefined;
		try {
			await database`INSERT INTO documents
				(id, owner_id, workspace_id, category_id, title, content)
				VALUES (${sourceId}::uuid, ${ids.actorA}::uuid, ${workspaceA}, ${ids.categoryA}::uuid, ${title}, 'race')`;
			mutationTask = database.begin(async (tx) => {
				const [connection] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
				blockerPid = connection?.pid;
				await tx`SELECT pg_advisory_xact_lock(${key})`;
				await tx`UPDATE documents SET category_id = ${ids.categoryOther}::uuid
					WHERE id = ${sourceId}::uuid`;
				ready.resolve(undefined);
				await release.promise;
			});
			await ready.promise;
			const responsePromise = requestWithAssertion(
				`/api/documents/${sourceId}/duplicate`,
				assertion,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${serviceApiKey}`,
						"x-forwarded-for": "198.51.100.43",
					},
				},
			);
			let blocked = false;
			try {
				if (!blockerPid) throw new Error("Missing topology blocker PID");
				blocked = await waitForTopologyLockWait(blockerPid);
			} finally {
				release.resolve(undefined);
			}
			const response = await responsePromise;
			await mutationTask;
			expect(response.status).toBe(404);
			expect(blocked).toBe(true);
			const rows = await database<{ count: number }[]>`SELECT count(*)::int AS count
				FROM documents WHERE title = ${`${title} (Copy)`}`;
			expect(rows[0]?.count).toBe(0);
		} finally {
			release.resolve(undefined);
			await mutationTask?.catch(() => undefined);
			await database`DELETE FROM documents
				WHERE id = ${sourceId}::uuid OR title = ${`${title} (Copy)`}`;
		}
	});

	test("replays a scoped cached 404 without a second database lookup", async () => {
		const assertion = await createAssertion(["read"]);
		const cacheKey = `hiai-docs:cache:docs:single:${ids.actorA}:w:${workspaceA}:${ids.docCacheProbe}:scope:${ids.categoryA}`;
		await contractRedis.del(cacheKey);
		try {
			expect(
				(await requestWithAssertion(
					`/api/documents/${ids.docCacheProbe}`,
					assertion,
				)).status,
			).toBe(404);
			await database`UPDATE documents
				SET category_id = ${ids.categoryA}::uuid, updated_at = NOW()
				WHERE id = ${ids.docCacheProbe}::uuid`;

			const cachedMiss = await requestWithAssertion(
				`/api/documents/${ids.docCacheProbe}`,
				assertion,
			);
			expect(cachedMiss.status).toBe(404);
			expect(await cachedMiss.json()).toEqual({ error: "Document not found" });

			await contractRedis.del(cacheKey);
			expect(
				(await requestWithAssertion(
					`/api/documents/${ids.docCacheProbe}`,
					assertion,
				)).status,
			).toBe(200);
		} finally {
			await database`UPDATE documents
				SET category_id = ${ids.categoryOther}::uuid, updated_at = NOW()
				WHERE id = ${ids.docCacheProbe}::uuid`;
			await contractRedis.del(cacheKey);
		}
	});

	test("proves scoped SDK CRUD, totals, pagination, search, graph, versions, export, and index operations", async () => {
		const assertion = await createAssertion(["read", "edit", "write"]);
		const docs = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: {
				workspaceAssertion: assertion,
				requestId: `sdk-${suffix}`,
			},
		});

		const folders = await docs.listFolders();
		expect(folders.map(({ id }) => id)).toEqual([ids.folderRootA]);
		const nestedFolders = await docs.listFolders(ids.folderRootA);
		expect(nestedFolders.map(({ id }) => id)).toEqual([ids.folderNestedA]);
		expect((await docs.listCategories()).map(({ id }) => id)).toEqual([
			ids.categoryA,
		]);
		expect((await docs.listTags()).map(({ id }) => id)).toEqual([ids.tagA]);

		const firstPage = await docs.listDocs({ page: 1, limit: 2 });
		const repeatedFirstPage = await docs.listDocs({ page: 1, limit: 2 });
		const secondPage = await docs.listDocs({ page: 2, limit: 2 });
		expect(firstPage.total).toBe(4);
		expect(secondPage.total).toBe(4);
		expect(repeatedFirstPage.items.map(({ id }) => id)).toEqual(
			firstPage.items.map(({ id }) => id),
		);
		expect(
			new Set([...firstPage.items, ...secondPage.items].map(({ id }) => id)),
		).toEqual(
			new Set([
				ids.docDirectA,
				ids.docNestedA,
				ids.docPageA1,
				ids.docPageA2,
			]),
		);

		const cursorOne = await docs.listDocuments({ limit: 2, sortBy: "updated" });
		expect(cursorOne.nextCursor).toBeString();
		const cursorTwo = await docs.listDocuments({
			limit: 2,
			sortBy: "updated",
			cursor: cursorOne.nextCursor ?? undefined,
		});
		expect(
			new Set([...cursorOne.items, ...cursorTwo.items].map(({ id }) => id)),
		).toEqual(
			new Set([
				ids.docDirectA,
				ids.docNestedA,
				ids.docPageA1,
				ids.docPageA2,
			]),
		);

		const search = await docs.search(lexicalNeedle, { graph: true, limit: 20 });
		expect(search.items.map(({ id }) => id)).toContain(ids.docDirectA);
		expect(search.items.map(({ id }) => id)).not.toContain(ids.docOther);
		expect(search.items.map(({ id }) => id)).not.toContain(ids.docForeign);
		expect(search.items.map(({ id }) => id)).not.toContain(ids.docDeleted);
		expect(search.diagnostics?.fastChannels).toContain("vector");
		expect(search.diagnostics?.channelErrors).not.toHaveProperty("vector");
		expect(search.diagnostics?.graphAttempted).toBe(true);
		expect(search.diagnostics?.graphContribution).toBe(true);

		const related = await docs.getRelatedDocuments(ids.docDirectA);
		expect(related.related.map(({ docId }) => docId)).toEqual([ids.docNestedA]);
		const graph = await docs.graphSearch({
			query: graphEntity,
			docIds: [ids.docDirectA],
			maxResults: 10,
		});
		expect(graph.relatedDocs.map(({ docId }) => docId)).toEqual([
			ids.docNestedA,
		]);

		expect((await docs.listVersions(ids.docDirectA)).map(({ id }) => id)).toEqual([
			ids.snapshotA,
			ids.versionA,
		]);
		expect(await docs.exportDoc(ids.docDirectA)).toContain(lexicalNeedle);
		expect(await docs.getDocumentIndexStatus(ids.docDirectA)).toMatchObject({
			documentId: ids.docDirectA,
			embeddingStatus: "ready",
			searchable: true,
		});
		expect(await docs.refreshDocumentIndex(ids.docDirectA)).toMatchObject({
			documentId: ids.docDirectA,
		});

		const created = await docs.createDoc(
			{ title: "SDK scoped create", categoryId: ids.categoryA },
			{ idempotencyKey: `sdk-create-${suffix}` },
		);
		expect(created.workspaceId).toBe(workspaceA);
		const edited = await docs.updateDoc(created.id, {
			title: "SDK scoped edit",
		});
		expect(edited.title).toBe("SDK scoped edit");
		const moved = await docs.updateDoc(created.id, {
			folderId: ids.folderNestedA,
			categoryId: null,
		});
		expect(moved.folderId).toBe(ids.folderNestedA);

		await expect(
			docs.getDoc(ids.docOther),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			docs.updateDoc(created.id, { folderId: ids.folderOther }),
		).rejects.toMatchObject({ status: 403 });
	});

	test("authorizes vector and GraphRAG candidates before normal-search fusion", async () => {
		const ctx: TenantContext = {
			userId: ids.actorA,
			role: "user",
			workspaceId: workspaceA,
			source: "external",
			resourceScope: {
				kind: "category",
				categoryId: ids.categoryA,
				permissions: ["read"],
			},
		};
		const authorizedDocumentIds = [
			ids.docDirectA,
			ids.docNestedA,
			ids.docPageA1,
			ids.docPageA2,
		];
		const execute = async (
			_channel: string,
			tenantContext: TenantContext,
			query: unknown,
		): Promise<unknown[]> =>
			withTenantDatabase(observedDatabase.db, tenantContext, async (tx) => {
				const rows = await tx.execute(query as SQL);
				return rows as unknown as unknown[];
			});
		queryObservations.length = 0;
		const embeddingRequestsBefore = embeddingRequests;
		const domain = await searchDocuments(
			ctx,
			{
				query: lexicalNeedle,
				limit: 20,
				graphEnabled: true,
				documentIds: authorizedDocumentIds,
				authorizedCategoryId: ids.categoryA,
				visibilityScope: {
					kind: "share",
					ownerId: ids.actorA,
					allowedDocumentIds: authorizedDocumentIds,
				},
			},
			{
				retrieveFast: (tenantContext, plan, options) =>
					retrieveFastChannels(tenantContext, plan, {
						...options,
						execute,
					}),
				retrieveGraph: (tenantContext, request) =>
					retrieveGraphCandidates(tenantContext, request, {
						withTenant: (transactionContext, operation) =>
							withTenantDatabase(
								observedDatabase.db,
								transactionContext,
								operation,
							),
					}),
			},
		);

		expect(embeddingRequests).toBeGreaterThan(embeddingRequestsBefore);
		expect(domain.diagnostics.fastChannels).toContain("vector");
		expect(domain.diagnostics.channelErrors).not.toHaveProperty("vector");
		expect(domain.diagnostics.graphAttempted).toBe(true);
		expect(domain.diagnostics.graphFailed).toBe(false);
		expect(domain.diagnostics.graphContribution).toBe(true);
		expect(domain.items.find(({ documentId }) => documentId === ids.docDirectA)?.channels).toContain("vector");
		expect(domain.items.find(({ documentId }) => documentId === ids.docNestedA)?.channels).toContain("graph");
		for (const hostileId of [ids.docOther, ids.docForeign, ids.docDeleted]) {
			expect(domain.items.map(({ documentId }) => documentId)).not.toContain(
				hostileId,
			);
		}

		const normalized = queryObservations.map(({ query }) =>
			query.replaceAll(/\s+/g, " ").trim().toLowerCase(),
		);
		const vectorQueries = normalized.filter((query) =>
			query.includes("from document_embeddings"),
		);
		const graphVisibilityQueries = normalized.filter(
			(query) =>
				query.includes('from "documents"') &&
				query.includes('"active_embedding_generation"'),
		);
		expect(vectorQueries).toHaveLength(1);
		expect(graphVisibilityQueries.length).toBeGreaterThanOrEqual(2);
		for (const query of [...vectorQueries, ...graphVisibilityQueries]) {
			expect(query).toContain("deleted_at");
			expect(query).toContain("with recursive ancestors");
			expect(query).toContain("coalesce");
		}
		expect(vectorQueries[0]?.indexOf("coalesce")).toBeLessThan(
			vectorQueries[0]?.lastIndexOf(" limit ") ?? -1,
		);
	});

	test("preserves index error statuses and never enqueues foreign dependent IDs", async () => {
		const assertion = await createAssertion(["read", "edit", "write"]);
		const docs = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: { workspaceAssertion: assertion },
		});
		const hostileIds = [ids.docOther, ids.docForeign, ids.docDeleted];
		const beforeRows = await database<{ count: string }[]>`SELECT count(*)::text AS count
			FROM document_pipeline_runs
			WHERE document_id IN (${ids.docOther}::uuid, ${ids.docForeign}::uuid, ${ids.docDeleted}::uuid)`;

		for (const documentId of hostileIds) {
			await expect(docs.listVersions(documentId)).rejects.toMatchObject({
				status: 404,
				code: "http_404",
			});
			await expect(docs.exportDoc(documentId)).rejects.toMatchObject({
				status: 404,
				code: "http_404",
			});
			await expect(docs.getDocumentIndexStatus(documentId)).rejects.toMatchObject({
				status: 404,
				code: "http_404",
			});
			await expect(docs.refreshDocumentIndex(documentId)).rejects.toMatchObject({
				status: 404,
				code: "http_404",
			});
		}

		await expect(docs.getDocumentIndexStatus("not-a-uuid")).rejects.toMatchObject({
			status: 400,
			code: "http_400",
		});
		const readOnly = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: {
				workspaceAssertion: await createAssertion(["read"]),
			},
		});
		await expect(readOnly.refreshDocumentIndex(ids.docDirectA)).rejects.toMatchObject({
			status: 403,
			code: "http_403",
		});

		const afterRows = await database<{ count: string }[]>`SELECT count(*)::text AS count
			FROM document_pipeline_runs
			WHERE document_id IN (${ids.docOther}::uuid, ${ids.docForeign}::uuid, ${ids.docDeleted}::uuid)`;
		expect(afterRows[0]?.count).toBe(beforeRows[0]?.count);
	});

	test("binds presign upload confirm read and delete to the contract Seaweed endpoint", async () => {
		const assertion = await createAssertion(["read", "edit", "write"]);
		const docs = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: { workspaceAssertion: assertion },
		});
		const bytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x54, 0x41, 0x53,
			0x4b, 0x32,
		]);
		const filename = `task2-contract-${suffix}.png`;
		const presigned = await docs.presignAttachment(ids.docDirectA, {
			filename,
			contentType: "image/png",
			size: bytes.byteLength,
		});
		let attachmentId: string | undefined;
		let uploadedObjectKey: string | undefined;
		try {
			expect(new URL(presigned.url).origin).toBe(new URL(storageUrl).origin);
			const upload = await fetch(presigned.url, {
				method: "PUT",
				headers: { "content-type": "image/png" },
				body: bytes,
			});
			expect(upload.status).toBe(200);
			uploadedObjectKey = presigned.key;
			orphanedObjectKeys.add(uploadedObjectKey);
			const attachment = await docs.confirmAttachment(ids.docDirectA, {
				key: presigned.key,
				filename,
				contentType: "image/png",
				size: bytes.byteLength,
				quotaReservationId: presigned.quotaReservationId,
			});
			attachmentId = attachment.id;
			const raw = await requestWithAssertion(attachment.url, assertion);
			expect(raw.status).toBe(200);
			expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
		} finally {
			await cleanupContractUpload(docs, uploadedObjectKey, attachmentId);
		}
		if (attachmentId) {
			expect(
				(await docs.listAttachments(ids.docDirectA)).items.map(({ id }) => id),
			).not.toContain(attachmentId);
		}
		if (uploadedObjectKey) {
			expect(await contractObjectExists(uploadedObjectKey)).toBe(false);
		}
	});

	test("does not leave a direct upload behind when confirmation fails", async () => {
		const assertion = await createAssertion(["read", "edit", "write"]);
		const docs = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: { workspaceAssertion: assertion },
		});
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x46, 0x41, 0x49, 0x4c]);
		const filename = `task2-confirm-failure-${suffix}.png`;
		const presigned = await docs.presignAttachment(ids.docDirectA, {
			filename,
			contentType: "image/png",
			size: bytes.byteLength,
		});
		let attachmentId: string | undefined;
		let uploadedObjectKey: string | undefined;
		try {
			const upload = await fetch(presigned.url, {
				method: "PUT",
				headers: { "content-type": "image/png" },
				body: bytes,
			});
			expect(upload.status).toBe(200);
			uploadedObjectKey = presigned.key;
			orphanedObjectKeys.add(uploadedObjectKey);
			await expect(
				docs.confirmAttachment(ids.docDirectA, {
					key: presigned.key,
					filename,
					contentType: "application/octet-stream",
					size: bytes.byteLength,
					quotaReservationId: presigned.quotaReservationId,
				}),
			).rejects.toMatchObject({ status: 415, code: "http_415" });
		} finally {
			await cleanupContractUpload(docs, uploadedObjectKey, attachmentId);
		}
		expect(await contractObjectExists(presigned.key)).toBe(false);
	});

	test("executes all 17 MCP tools through one sanitized assertion-bound public client", async () => {
		const assertion = await createAssertion(["read", "edit", "write"]);
		const observedRequests: Array<{
			url: string;
			method: string;
			headers: Headers;
		}> = [];
		const docsClient = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			fetch: async (input, init) => {
				observedRequests.push({
					url: String(input),
					method: init?.method ?? "GET",
					headers: new Headers(init?.headers),
				});
				return fetch(input, init);
			},
		});
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		const server = createDocsmintMcpServer({
			docsClient,
			requestContext: {
				workspaceAssertion: assertion,
				authorization: "Bearer caller-token",
				cookie: "caller-cookie=secret",
				headers: {
					Authorization: "Bearer duplicate-caller-token",
					Cookie: "duplicate-caller-cookie=secret",
				},
				requestId: `mcp-${suffix}`,
				idempotencyKey: `mcp-idempotency-${suffix}`,
			},
		});
		mcpClient = new Client({ name: "live-contract", version: "1.0.0" });
		await Promise.all([
			server.connect(serverTransport),
			mcpClient.connect(clientTransport),
		]);
		closeMcp = async () => {
			await mcpClient?.close();
			await server.close();
		};
		const [discoveredTools, discoveredPrompts, discoveredResources] =
			await Promise.all([
				mcpClient.listTools(),
				mcpClient.listPrompts(),
				mcpClient.listResources(),
			]);
		expect(discoveredTools.tools.map(({ name }) => name)).toEqual([
			...capabilityCatalog.tools,
		]);
		expect(discoveredPrompts.prompts.map(({ name }) => name)).toEqual([
			...capabilityCatalog.prompts,
		]);
		expect(discoveredResources.resources.map(({ uri }) => uri)).toEqual([
			...capabilityCatalog.resources,
		]);

		const toolCases: Array<{
			name: (typeof capabilityCatalog.tools)[number];
			arguments: Record<string, unknown>;
			error?: { status: number; code: string };
		}> = [
			{ name: "search_documents", arguments: { query: lexicalNeedle, limit: 5 } },
			{ name: "get_document", arguments: { id: ids.docDirectA } },
			{
				name: "create_document",
				arguments: { title: "MCP scoped create", categoryId: ids.categoryA },
			},
			{
				name: "update_document",
				arguments: { id: ids.docDirectA, title: "Scoped direct MCP" },
			},
			{ name: "list_documents", arguments: { page: 1, limit: 2 } },
			{ name: "list_folders", arguments: {} },
			{
				name: "create_folder",
				arguments: {
					name: `MCP folder ${suffix}`,
					parentId: ids.folderRootA,
				},
			},
			{
				name: "create_snapshot",
				arguments: { documentId: ids.docDirectA, label: "MCP snapshot" },
			},
			{
				name: "get_version_history",
				arguments: { documentId: ids.docDirectA },
			},
			{ name: "export_document", arguments: { id: ids.docDirectA } },
			{ name: "list_categories", arguments: {} },
			{
				name: "create_category",
				arguments: { name: "Forbidden category" },
				error: { status: 403, code: "http_403" },
			},
			{ name: "list_tags", arguments: {} },
			{
				name: "get_related_documents",
				arguments: { documentId: ids.docDirectA, limit: 10 },
			},
			{
				name: "search_knowledge_graph",
				arguments: {
					query: graphEntity,
					docIds: [ids.docDirectA],
					limit: 10,
				},
			},
			{
				name: "get_document_index_status",
				arguments: { documentId: ids.docDirectA },
			},
			{
				name: "refresh_document_index",
				arguments: { documentId: ids.docDirectA },
			},
		];
		expect(toolCases.map(({ name }) => name)).toEqual([
			...capabilityCatalog.tools,
		]);

		for (const tool of toolCases) {
			const before = observedRequests.length;
			const result = await mcpClient.callTool({
				name: tool.name,
				arguments: tool.arguments,
			});
			expect(observedRequests.length - before, tool.name).toBe(1);
			if (tool.error) {
				expect(result.isError, tool.name).toBe(true);
				const body = JSON.parse(
					(result.content as Array<{ text?: string }>)[0]?.text ?? "{}",
				);
				expect(body, tool.name).toMatchObject({
					type: "DocsApiError",
					status: tool.error.status,
					code: tool.error.code,
					message: "Full workspace write access required",
					body: { error: "Full workspace write access required" },
				});
			} else {
				expect(result.isError, tool.name).not.toBe(true);
			}
		}

		expect(observedRequests).toHaveLength(17);
		expect(observedRequests.every(({ method }) => method !== "OPTIONS")).toBe(
			true,
		);
		for (const request of observedRequests) {
			expect(request.headers.get("authorization")).toBe(
				`Bearer ${serviceApiKey}`,
			);
			expect(request.headers.get("cookie")).toBeNull();
			expect(request.headers.get("x-docsmint-workspace-context")).toBe(
				assertion,
			);
			expect(request.headers.get("x-request-id")).toBe(`mcp-${suffix}`);
		}

		const beforeCatalog = observedRequests.length;
		const catalog = await mcpClient.readResource({
			uri: "docsmint://workspace/catalog",
		});
		expect(catalog.contents).toHaveLength(1);
		expect(observedRequests.length - beforeCatalog).toBe(3);
	});

	test("preserves structured SDK conflict errors", async () => {
		const assertion = await createAssertion(["read", "edit", "write"]);
		const docs = new DocsClient({
			baseUrl,
			apiKey: serviceApiKey,
			retries: 1,
			requestContext: { workspaceAssertion: assertion },
		});
		const current = await docs.getDoc(ids.docDirectA);
		await docs.updateDoc(ids.docDirectA, { title: "Conflict winner" });
		const error = await docs
			.updateDoc(ids.docDirectA, {
				title: "Conflict loser",
				expectedUpdatedAt: current.updatedAt,
			})
			.catch((caught) => caught);
		expect(error).toBeInstanceOf(DocsApiError);
		expect(error).toMatchObject({ status: 409, code: "DOCUMENT_CONFLICT" });
	});
});
