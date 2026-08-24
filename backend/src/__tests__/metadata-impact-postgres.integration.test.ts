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

import {
	reembedDocsInCategory,
	reembedDocsInFolder,
	snapshotMetadataImpact,
} from "../lib/reembed";
import { acquireTenantTopologyLock } from "../lib/topology-serialization";

const databaseUrl = Bun.env.CONTENT_ACCESS_TEST_DATABASE_URL?.trim();

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
		if ((row?.blocker_pids as number[] | undefined)?.includes(blockerPid))
			return;
		await Bun.sleep(10);
	}
	throw new Error(
		"descendant attach did not block on the subtree folder locks",
	);
}

describe.skipIf(!databaseUrl)(
	"recursive metadata impact PostgreSQL contract",
	() => {
		test("public re-embed helpers keep owner and external-workspace rows in their canonical tenants", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const workspaceId = `metadata-helper-${crypto.randomUUID()}`;
			const personalFolderId = crypto.randomUUID();
			const workspaceFolderId = crypto.randomUUID();
			const workspaceCategoryId = crypto.randomUUID();
			const personalFolderDocumentId = crypto.randomUUID();
			const workspaceFolderDocumentId = crypto.randomUUID();
			const personalCategoryDocumentId = crypto.randomUUID();
			const workspaceCategoryDocumentId = crypto.randomUUID();

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-helper.invalid`})`;
				await setup`INSERT INTO public.categories
					(id, owner_id, workspace_id, name)
					VALUES (${workspaceCategoryId}::uuid, ${ownerId}::uuid, ${workspaceId}, 'workspace helper')`;
				await setup`INSERT INTO public.folders
					(id, owner_id, workspace_id, parent_id, category_id, name)
					VALUES
						(${personalFolderId}::uuid, ${ownerId}::uuid, NULL, NULL, NULL, 'personal helper'),
						(${workspaceFolderId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, NULL, 'workspace helper')`;
				await setup`INSERT INTO public.documents
					(id, owner_id, workspace_id, folder_id, category_id, title, content)
					VALUES
						(${personalFolderDocumentId}::uuid, ${ownerId}::uuid, NULL, ${personalFolderId}::uuid, NULL, 'personal folder', ''),
						(${workspaceFolderDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${workspaceFolderId}::uuid, NULL, 'workspace folder', ''),
						(${personalCategoryDocumentId}::uuid, ${ownerId}::uuid, NULL, NULL, ${workspaceCategoryId}::uuid, 'personal category mismatch', ''),
						(${workspaceCategoryDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, ${workspaceCategoryId}::uuid, 'workspace category', '')`;

				const personalFolder = await reembedDocsInFolder(
					personalFolderId,
					ownerId,
				);
				const workspaceFolder = await reembedDocsInFolder(
					workspaceFolderId,
					ownerId,
					workspaceId,
				);
				const workspaceAgainstPersonalFolder = await reembedDocsInFolder(
					personalFolderId,
					ownerId,
					workspaceId,
				);
				const workspaceCategory = await reembedDocsInCategory(
					workspaceCategoryId,
					ownerId,
					workspaceId,
				);

				expect(personalFolder).toBe(1);
				expect(workspaceFolder).toBe(1);
				expect(workspaceAgainstPersonalFolder).toBe(0);
				expect(workspaceCategory).toBe(1);
				const queued = await setup<{ document_id: string }[]>`
					SELECT document_id::text
					FROM public.document_pipeline_runs
					WHERE document_id IN (
						${personalFolderDocumentId}::uuid,
						${workspaceFolderDocumentId}::uuid,
						${personalCategoryDocumentId}::uuid,
						${workspaceCategoryDocumentId}::uuid
					)`;
				expect(queued.map(({ document_id }) => document_id).sort()).toEqual(
					[
						personalFolderDocumentId,
						workspaceFolderDocumentId,
						workspaceCategoryDocumentId,
					].sort(),
				);
			} finally {
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await setup.end();
			}
		});

		test("finds direct and two-level effective-category documents in owner and workspace tenants", async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const observations: DatabaseQueryObservation[] = [];
			const observed = createDatabaseClient(databaseUrl as string, {
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
						snapshotMetadataImpact(
							tx,
							{ userId: ownerId, role: "user" },
							{
								kind: "category",
								id: personalCategoryId,
							},
						),
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
				expect(workspace.documents.map(({ id }) => id)).not.toContain(
					foreignDocument,
				);

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
			const setup = postgres(databaseUrl as string, { max: 1 });
			const locker = createDatabaseClient(databaseUrl as string, { max: 1 });
			const attach = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const rootId = crypto.randomUUID();
			const childId = crypto.randomUUID();
			const grandchildId = crypto.randomUUID();
			const detachedDocumentId = crypto.randomUUID();
			const snapshotReady = deferred<{
				blockerPid: number;
				documentIds: string[];
			}>();
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

		test.each(["personal", "workspace"] as const)(
			"serializes %s multi-level reparent and document attach behind a recursive delete snapshot",
			async (mode) => {
				const setup = postgres(databaseUrl as string, { max: 1 });
				const rowBlocker = postgres(databaseUrl as string, { max: 1 });
				const snapshotClient = createDatabaseClient(databaseUrl as string, {
					max: 1,
				});
				const mutationClient = createDatabaseClient(databaseUrl as string, {
					max: 1,
				});
				const observer = postgres(databaseUrl as string, { max: 1 });
				const ownerId = crypto.randomUUID();
				const workspaceId =
					mode === "workspace" ? `metadata-race-${crypto.randomUUID()}` : null;
				const rootId = "ffffffff-ffff-4fff-8fff-fffffffff201";
				const childId = "00000000-0000-4000-8000-000000000201";
				const grandchildId = "11111111-1111-4111-8111-111111111201";
				const detachedRootId = "22222222-2222-4222-8222-222222222201";
				const detachedChildId = "33333333-3333-4333-8333-333333333201";
				const detachedDocumentId = crypto.randomUUID();
				const attachDocumentId = crypto.randomUUID();
				const blockerReady = deferred<number>();
				const releaseBlocker = deferred<void>();
				const snapshotPid = deferred<number>();
				const mutationPid = deferred<number>();
				const context: TenantContext = workspaceId
					? {
							userId: ownerId,
							role: "user",
							source: "external",
							workspaceId,
						}
					: { userId: ownerId, role: "user", source: "personal" };

				try {
					await setup`INSERT INTO public.users (id, email)
						VALUES (${ownerId}::uuid, ${`${ownerId}@metadata-race.invalid`})`;
					await setup`INSERT INTO public.folders
						(id, owner_id, workspace_id, parent_id, name)
						VALUES
							(${rootId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, 'root'),
							(${childId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${rootId}::uuid, 'child'),
							(${grandchildId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${childId}::uuid, 'grandchild'),
							(${detachedRootId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, 'detached root'),
							(${detachedChildId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${detachedRootId}::uuid, 'detached child')`;
					await setup`INSERT INTO public.documents
						(id, owner_id, workspace_id, folder_id, title, content)
						VALUES
							(${detachedDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, ${detachedChildId}::uuid, 'reparented', ''),
							(${attachDocumentId}::uuid, ${ownerId}::uuid, ${workspaceId}, NULL, 'attached', '')`;

					const blockerTask = rowBlocker.begin(async (tx) => {
						const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
						await tx`SELECT id FROM public.folders
							WHERE id = ${childId}::uuid FOR UPDATE`;
						blockerReady.resolve(backend?.pid as number);
						await releaseBlocker.promise;
					});
					const blockerPid = await blockerReady.promise;
					const snapshotTask = withTenantDatabase(
						snapshotClient.db,
						context,
						async (tx) => {
							const backendRows = (await tx.execute(
								sql`SELECT pg_backend_pid() AS pid`,
							)) as unknown as Array<{ pid: number }>;
							snapshotPid.resolve(backendRows[0]?.pid ?? -1);
							return snapshotMetadataImpact(
								tx,
								context,
								{ kind: "folder", id: rootId },
								{ lockFolders: true },
							);
						},
					);
					await waitForBlock(observer, await snapshotPid.promise, blockerPid);

					const mutationTask = withTenantDatabase(
						mutationClient.db,
						context,
						async (tx) => {
							const backendRows = (await tx.execute(
								sql`SELECT pg_backend_pid() AS pid`,
							)) as unknown as Array<{ pid: number }>;
							mutationPid.resolve(backendRows[0]?.pid ?? -1);
							await acquireTenantTopologyLock(tx, context);
							await tx.execute(sql`UPDATE public.folders
								SET parent_id = ${grandchildId}::uuid
								WHERE id = ${detachedRootId}::uuid`);
							await tx.execute(sql`UPDATE public.documents
								SET folder_id = ${grandchildId}::uuid
								WHERE id = ${attachDocumentId}::uuid`);
						},
					);
					await waitForBlock(
						observer,
						await mutationPid.promise,
						await snapshotPid.promise,
					);
					releaseBlocker.resolve();
					const snapshot = await snapshotTask;
					await Promise.all([blockerTask, mutationTask]);

					expect(snapshot.documents.map(({ id }) => id)).not.toContain(
						detachedDocumentId,
					);
					expect(snapshot.documents.map(({ id }) => id)).not.toContain(
						attachDocumentId,
					);
					const [reparented] = await setup<{ parent_id: string }[]>`
						SELECT parent_id::text FROM public.folders
						WHERE id = ${detachedRootId}::uuid`;
					const [attached] = await setup<{ folder_id: string }[]>`
						SELECT folder_id::text FROM public.documents
						WHERE id = ${attachDocumentId}::uuid`;
					expect(reparented?.parent_id).toBe(grandchildId);
					expect(attached?.folder_id).toBe(grandchildId);
				} finally {
					releaseBlocker.resolve();
					await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
					await Promise.all([
						setup.end(),
						rowBlocker.end(),
						snapshotClient.client.end(),
						mutationClient.client.end(),
						observer.end(),
					]);
				}
			},
		);
	},
);
