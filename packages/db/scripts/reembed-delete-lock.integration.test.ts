import { describe, expect, it } from "bun:test";
import postgres from "postgres";

const databaseUrl = process.env.LIFECYCLE_TEST_DATABASE_URL;
const integrationIt = databaseUrl ? it : it.skip;

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
		if ((row?.blocker_pids as number[] | undefined)?.includes(blockerPid)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("concurrent FK attach did not block on the parent row lock");
}

describe("re-embed delete parent-row lock integration", () => {
	integrationIt(
		"blocks document and folder attaches until the locked parent is deleted",
		async () => {
			const setup = postgres(databaseUrl as string, { max: 1 });
			const folderDelete = postgres(databaseUrl as string, { max: 1 });
			const folderAttach = postgres(databaseUrl as string, { max: 1 });
			const categoryDelete = postgres(databaseUrl as string, { max: 1 });
			const categoryAttach = postgres(databaseUrl as string, { max: 1 });
			const observer = postgres(databaseUrl as string, { max: 1 });
			const ownerId = crypto.randomUUID();
			const folderId = crypto.randomUUID();
			const documentId = crypto.randomUUID();
			const categoryId = crypto.randomUUID();
			const categoryFolderId = crypto.randomUUID();

			try {
				await setup`INSERT INTO public.users (id, email)
					VALUES (${ownerId}::uuid, ${`${ownerId}@reembed-lock.invalid`})`;
				await setup`INSERT INTO public.folders (id, owner_id, name)
					VALUES (${folderId}::uuid, ${ownerId}::uuid, 'delete-lock')`;
				await setup`INSERT INTO public.documents (id, owner_id, title, content)
					VALUES (${documentId}::uuid, ${ownerId}::uuid, 'attach-later', '')`;
				await setup`INSERT INTO public.categories (id, owner_id, name)
					VALUES (${categoryId}::uuid, ${ownerId}::uuid, 'delete-lock')`;
				await setup`INSERT INTO public.folders (id, owner_id, name)
					VALUES (${categoryFolderId}::uuid, ${ownerId}::uuid, 'attach-later')`;

				const folderSnapshotReady = deferred<{
					blockerPid: number;
					documentIds: string[];
				}>();
				const folderAttachPid = deferred<number>();
				const allowFolderDelete = deferred<void>();
				const folderDeleteTask = folderDelete.begin(async (tx) => {
					const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
					await tx`SELECT id FROM public.folders
						WHERE id = ${folderId}::uuid AND owner_id = ${ownerId}::uuid
						FOR UPDATE`;
					const rows = await tx`SELECT id FROM public.documents
						WHERE folder_id = ${folderId}::uuid AND owner_id = ${ownerId}::uuid`;
					folderSnapshotReady.resolve({
						blockerPid: backend?.pid as number,
						documentIds: rows.map((row) => row.id as string),
					});
					await allowFolderDelete.promise;
					await tx`DELETE FROM public.folders
						WHERE id = ${folderId}::uuid AND owner_id = ${ownerId}::uuid`;
				});
				const folderAttachTask = folderAttach
					.begin(async (tx) => {
						const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
						folderAttachPid.resolve(backend?.pid as number);
						await folderSnapshotReady.promise;
						await tx`UPDATE public.documents SET folder_id = ${folderId}::uuid
							WHERE id = ${documentId}::uuid AND owner_id = ${ownerId}::uuid`;
					})
					.then(
						() => "committed",
						(error: { code?: string }) => error.code,
					);
				const folderSnapshot = await folderSnapshotReady.promise;
				let folderBarrierError: unknown;
				try {
					await waitForBlock(
						observer,
						await folderAttachPid.promise,
						folderSnapshot.blockerPid,
					);
				} catch (error) {
					folderBarrierError = error;
				} finally {
					allowFolderDelete.resolve();
				}
				expect(folderSnapshot.documentIds).toEqual([]);
				expect(await folderAttachTask).toBe("23503");
				await folderDeleteTask;
				if (folderBarrierError) throw folderBarrierError;

				const categorySnapshotReady = deferred<{
					blockerPid: number;
					folderIds: string[];
				}>();
				const categoryAttachPid = deferred<number>();
				const allowCategoryDelete = deferred<void>();
				const categoryDeleteTask = categoryDelete.begin(async (tx) => {
					const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
					await tx`SELECT id FROM public.categories
						WHERE id = ${categoryId}::uuid AND owner_id = ${ownerId}::uuid
						FOR UPDATE`;
					const rows = await tx`SELECT id FROM public.folders
						WHERE category_id = ${categoryId}::uuid AND owner_id = ${ownerId}::uuid`;
					categorySnapshotReady.resolve({
						blockerPid: backend?.pid as number,
						folderIds: rows.map((row) => row.id as string),
					});
					await allowCategoryDelete.promise;
					await tx`DELETE FROM public.categories
						WHERE id = ${categoryId}::uuid AND owner_id = ${ownerId}::uuid`;
				});
				const categoryAttachTask = categoryAttach
					.begin(async (tx) => {
						const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
						categoryAttachPid.resolve(backend?.pid as number);
						await categorySnapshotReady.promise;
						await tx`UPDATE public.folders SET category_id = ${categoryId}::uuid
							WHERE id = ${categoryFolderId}::uuid AND owner_id = ${ownerId}::uuid`;
					})
					.then(
						() => "committed",
						(error: { code?: string }) => error.code,
					);
				const categorySnapshot = await categorySnapshotReady.promise;
				let categoryBarrierError: unknown;
				try {
					await waitForBlock(
						observer,
						await categoryAttachPid.promise,
						categorySnapshot.blockerPid,
					);
				} catch (error) {
					categoryBarrierError = error;
				} finally {
					allowCategoryDelete.resolve();
				}
				expect(categorySnapshot.folderIds).toEqual([]);
				expect(await categoryAttachTask).toBe("23503");
				await categoryDeleteTask;
				if (categoryBarrierError) throw categoryBarrierError;
			} finally {
				await setup`DELETE FROM public.users WHERE id = ${ownerId}::uuid`;
				await Promise.all([
					setup.end(),
					folderDelete.end(),
					folderAttach.end(),
					categoryDelete.end(),
					categoryAttach.end(),
					observer.end(),
				]);
			}
		},
	);
});
