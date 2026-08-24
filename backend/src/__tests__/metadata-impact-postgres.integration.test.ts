import { describe, expect, test } from "bun:test";
import {
	createDatabaseClient,
	type DatabaseQueryObservation,
} from "@hiai-docs/db/client";
import {
	type TenantContext,
	withTenantDatabase,
} from "@hiai-docs/db/with-tenant";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { snapshotMetadataImpact } from "../lib/reembed";

const databaseUrl = Bun.env.CONTENT_ACCESS_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
	throw new Error(
		"CONTENT_ACCESS_TEST_DATABASE_URL is required for database integration tests",
	);
}

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

async function waitForBlock(
	observer: postgres.Sql,
	blockedPid: number,
	blockerPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const [row] =
			await observer`SELECT pg_blocking_pids(${blockedPid}) AS blocker_pids`;
		if ((row?.blocker_pids as number[] | undefined)?.includes(blockerPid)) return;
		await Bun.sleep(10);
	}
	throw new Error("descendant attach did not block on the subtree folder locks");
}

describe("recursive metadata impact PostgreSQL contract", () => {
	test("finds direct and two-level effective-category documents in owner and workspace tenants", async () => {
		const setup = postgres(databaseUrl, { max: 1 });
		const observations: DatabaseQueryObservation[] = [];
		const observed = createDatabaseClient(databaseUrl, {
			max: 1,
			queryObserver: (observation) => observations.push(observation),
		});
		const ownerId = crypto.randomUUID();
		const otherOwnerId = crypto.randomUUID();
		const personalCategoryId = crypto.randomUUID();
		const workspaceCategoryId = crypto.randomUUID();
		const personalFolders = [
			crypto.randomUUID(),
			crypto.randomUUID(),
			crypto.randomUUID(),
		] as const;
		const workspaceFolders = [
			crypto.randomUUID(),
			crypto.randomUUID(),
			crypto.randomUUID(),
		] as const;
		const personalDirect = crypto.randomUUID();
		const personalNested = crypto.randomUUID();
		const workspaceDirect = crypto.randomUUID();
		const workspaceNested = crypto.randomUUID();
		const foreignDocument = crypto.randomUUID();
		const workspaceId = `metadata-impact-${crypto.randomUUID()}`;
		const foreignWorkspaceId = `metadata-impact-foreign-${crypto.randomUUID()}`;

		try {
			await setup`INSERT INTO public.users (id, email)
				VALUES
					(${ownerId}::uuid, ${`${ownerId}@metadata-impact.invalid`}),
					(${otherOwnerId}::uuid, ${`${otherOwnerId}@metadata-impact.invalid`})`;
			await setup`INSERT INTO public.categories
				(id, owner_id, workspace_id, name)
				VALUES
					(${personalCategoryId}::uuid, ${ownerId}::uuid, NULL, 'personal impact'),
					(${workspaceCategoryId}::uuid, ${ownerId}::uuid, ${workspaceId}, 'workspace impact')`;
			await setup`INSERT INTO public.folders
				(id, owner_id, workspace_id, parent_id, category_id, name)
				VALUES
					(${personalFolders[0]}::uuid, ${ownerId}::uuid, NULL, NULL, ${personalCategoryId}::uuid, 'personal root'),
					(${personalFolders[1]}::uuid, ${ownerId}::uuid, NULL, ${personalFolders[0]}::uuid, NULL, 'personal child'),
					(${personalFolders[2]}::uuid, ${ownerId}::uuid, NULL, ${personalFolders[1]}::uuid, NULL, 'personal grandchild'),
					(${workspaceFolders[0]}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, ${workspaceCategoryId}::uuid, 'workspace root'),
					(${workspaceFolders[1]}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolders[0]}::uuid, NULL, 'workspace child'),
					(${workspaceFolders[2]}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolders[1]}::uuid, NULL, 'workspace grandchild')`;
			await setup`INSERT INTO public.documents
				(id, owner_id, workspace_id, folder_id, category_id, title, content)
				VALUES
					(${personalDirect}::uuid, ${ownerId}::uuid, NULL, NULL, ${personalCategoryId}::uuid, 'personal direct', ''),
					(${personalNested}::uuid, ${ownerId}::uuid, NULL, ${personalFolders[2]}::uuid, NULL, 'personal nested', ''),
					(${workspaceDirect}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, ${workspaceCategoryId}::uuid, 'workspace direct', ''),
					(${workspaceNested}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolders[2]}::uuid, NULL, 'workspace nested', ''),
					(${foreignDocument}::uuid, ${otherOwnerId}::uuid, ${foreignWorkspaceId}, NULL, NULL, 'foreign', '')`;

			const personal = await withTenantDatabase(
				observed.db,
				{ userId: ownerId, role: "user" },
				(tx) =>
					snapshotMetadataImpact(tx, { userId: ownerId, role: "user" }, {
						kind: "category",
						id: personalCategoryId,
					}),
			);
			const workspaceContext: TenantContext = {
				userId: ownerId,
				role: "user",
				workspaceId,
				source: "external",
			};
			const workspace = await withTenantDatabase(
				observed.db,
				workspaceContext,
				(tx) =>
					snapshotMetadataImpact(
						tx,
						workspaceContext,
						{ kind: "category", id: workspaceCategoryId },
						{ lockFolders: true },
					),
			);
			const folder = await withTenantDatabase(
				observed.db,
				workspaceContext,
				(tx) =>
					snapshotMetadataImpact(tx, workspaceContext, {
						kind: "folder",
						id: workspaceFolders[0],
					}),
			);

			expect(personal.folderIds).toEqual([...personalFolders].sort());
			expect(personal.documents.map(({ id }) => id).sort()).toEqual(
				[personalDirect, personalNested].sort(),
			);
			expect(workspace.folderIds).toEqual([...workspaceFolders].sort());
			expect(workspace.documents.map(({ id }) => id).sort()).toEqual(
				[workspaceDirect, workspaceNested].sort(),
			);
			expect(folder.documents.map(({ id }) => id).sort()).toEqual(
				[workspaceNested].sort(),
			);
			expect(
				workspace.documents.map(({ id }) => id),
			).not.toContain(foreignDocument);

			const normalized = observations.map(({ query }) =>
				query.replaceAll(/\s+/g, " ").trim().toLowerCase(),
			);
			const recursiveCategory = normalized.find((query) =>
				query.includes("docsmint:metadata-impact:category"),
			);
			const lock = normalized.find(
				(query) => query.includes("for update") && query.includes("order by"),
			);
			expect(recursiveCategory).toContain("with recursive resolved_folders");
			expect(recursiveCategory).toContain("effective_category_id");
			expect(lock).toContain('order by "folders"."id" asc for update');
		} finally {
			await setup`DELETE FROM public.users
				WHERE id IN (${ownerId}::uuid, ${otherOwnerId}::uuid)`;
			await observed.client.end();
			await setup.end();
		}
	});

	test("holds deterministic descendant locks through the document snapshot", async () => {
		const setup = postgres(databaseUrl, { max: 1 });
		const locker = createDatabaseClient(databaseUrl, { max: 1 });
		const attach = postgres(databaseUrl, { max: 1 });
		const observer = postgres(databaseUrl, { max: 1 });
		const ownerId = crypto.randomUUID();
		const rootId = crypto.randomUUID();
		const childId = crypto.randomUUID();
		const grandchildId = crypto.randomUUID();
		const detachedDocumentId = crypto.randomUUID();
		const snapshotReady = deferred<{ blockerPid: number; documentIds: string[] }>();
		const releaseLocks = deferred<void>();
		const attachPid = deferred<number>();

		try {
			await setup`INSERT INTO public.users (id, email)
				VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-lock.invalid`})`;
			await setup`INSERT INTO public.folders (id, owner_id, parent_id, name)
				VALUES
					(${rootId}::uuid, ${ownerId}::uuid, NULL, 'root'),
					(${childId}::uuid, ${ownerId}::uuid, ${rootId}::uuid, 'child'),
					(${grandchildId}::uuid, ${ownerId}::uuid, ${childId}::uuid, 'grandchild')`;
			await setup`INSERT INTO public.documents (id, owner_id, title, content)
				VALUES (${detachedDocumentId}::uuid, ${ownerId}::uuid, 'detached', '')`;

			const context: TenantContext = { userId: ownerId, role: "user" };
			const lockTask = withTenantDatabase(locker.db, context, async (tx) => {
				const backendRows = (await tx.execute(
					sql`SELECT pg_backend_pid() AS pid`,
				)) as unknown as Array<{ pid: number }>;
				const snapshot = await snapshotMetadataImpact(
					tx,
					context,
					{ kind: "folder", id: rootId },
					{ lockFolders: true },
				);
				snapshotReady.resolve({
					blockerPid: backendRows[0]?.pid ?? -1,
					documentIds: snapshot.documents.map(({ id }) => id),
				});
				await releaseLocks.promise;
			});
			const attachTask = attach.begin(async (tx) => {
				const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
				attachPid.resolve(backend?.pid as number);
				await snapshotReady.promise;
				await tx`UPDATE public.documents SET folder_id = ${grandchildId}::uuid
					WHERE id = ${detachedDocumentId}::uuid`;
			});
			const snapshot = await snapshotReady.promise;
			let blockError: unknown;
			try {
				await waitForBlock(
					observer,
					await attachPid.promise,
					snapshot.blockerPid,
				);
			} catch (error) {
				blockError = error;
			} finally {
				releaseLocks.resolve();
			}
			expect(snapshot.documentIds).toEqual([]);
			await Promise.all([lockTask, attachTask]);
			if (blockError) throw blockError;
		} finally {
			await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
			await Promise.all([
				setup.end(),
				locker.client.end(),
				attach.end(),
				observer.end(),
			]);
		}
	});
});
