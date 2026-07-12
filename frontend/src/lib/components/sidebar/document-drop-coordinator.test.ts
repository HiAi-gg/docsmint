import { describe, expect, test } from "bun:test";
import {
	createDocumentDropCoordinator,
	createDocumentPlacementWriter,
	type SidebarDocumentPlacement,
} from "./document-drop-coordinator";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("sidebar document placement writer", () => {
	test("serializes rapid writes and an old failure cannot roll back the latest", async () => {
		const first = deferred();
		const calls: string[] = [];
		const rollbacks: string[] = [];
		const writer = createDocumentPlacementWriter({
			patch: async (_id, placement) => {
				calls.push(placement.folderId ?? "root");
				if (placement.folderId === "one") await first.promise;
			},
			optimistic: () => 1,
			acknowledge: () => {},
			rollback: (_id, placement) =>
				rollbacks.push(placement.folderId ?? "root"),
			refresh: async () => {},
			onError: () => {},
		});
		const v1 = writer(
			"doc",
			{ folderId: "one", categoryId: null },
			{ folderId: "old", categoryId: null },
		);
		const v2 = writer(
			"doc",
			{ folderId: "two", categoryId: null },
			{ folderId: "old", categoryId: null },
		);
		await Promise.resolve();
		expect(calls).toEqual(["one"]);
		first.reject(new Error("old failed"));
		await Promise.allSettled([v1, v2]);
		expect(calls).toEqual(["one", "two"]);
		expect(rollbacks).toEqual([]);
	});

	test("does not roll back a committed PATCH when refresh fails", async () => {
		const rollbacks: string[] = [];
		const errors: unknown[] = [];
		const writer = createDocumentPlacementWriter({
			patch: async () => {},
			optimistic: () => 7,
			acknowledge: () => {},
			rollback: (_id, placement) =>
				rollbacks.push(placement.folderId ?? "root"),
			refresh: async () => {
				throw new Error("refresh failed");
			},
			onError: (error) => errors.push(error),
			onRefreshError: (error) => errors.push(error),
		});
		await writer(
			"doc",
			{ folderId: "new", categoryId: null },
			{ folderId: "old", categoryId: null },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rollbacks).toEqual([]);
		expect(errors).toHaveLength(1);
	});

	test("commits immediately when no reconciliation refresh is configured", async () => {
		const acknowledgements: Array<[string, number]> = [];
		const writer = createDocumentPlacementWriter({
			patch: async () => {},
			optimistic: () => 11,
			acknowledge: (id, token) => acknowledgements.push([id, token]),
			rollback: () => {
				throw new Error("unexpected rollback");
			},
			onError: () => {},
		});

		await writer(
			"doc",
			{ folderId: null, categoryId: "category" },
			{ folderId: "old", categoryId: "category" },
		);

		expect(acknowledgements).toEqual([["doc", 11]]);
	});
});

describe("document drop coordinator", () => {
	const root: SidebarDocumentPlacement = { folderId: null, categoryId: null };
	const category: SidebarDocumentPlacement = {
		folderId: null,
		categoryId: "category",
	};
	const folder: SidebarDocumentPlacement = {
		folderId: "folder",
		categoryId: "category",
	};
	const nested: SidebarDocumentPlacement = {
		folderId: "nested",
		categoryId: null,
	};
	type Event = ["zone" | "header", SidebarDocumentPlacement];

	for (const scenario of [
		{
			name: "zone then header",
			events: [
				["zone", root],
				["header", category],
			] as Event[],
			expected: category,
		},
		{
			name: "header then zone",
			events: [
				["header", folder],
				["zone", root],
			] as Event[],
			expected: folder,
		},
		{
			name: "duplicate header",
			events: [
				["header", category],
				["header", folder],
			] as Event[],
			expected: category,
		},
		{
			name: "duplicate source and destination zones",
			events: [
				["zone", root],
				["zone", nested],
				["zone", nested],
			] as Event[],
			expected: nested,
		},
	] as const) {
		test(`${scenario.name} persists exactly one resolved target`, () => {
			const tasks: Array<() => void> = [];
			const cancelled = new Set<() => void>();
			const writes: SidebarDocumentPlacement[] = [];
			const coordinator = createDocumentDropCoordinator({
				persist: (_id, placement) => writes.push(placement),
				defer: (callback) => {
					tasks.push(callback);
					return callback as unknown as ReturnType<typeof setTimeout>;
				},
				cancel: (handle) => cancelled.add(handle as unknown as () => void),
			});
			coordinator.begin("doc", 1);
			// Repeated consider for the same drag transaction is idempotent.
			coordinator.begin("doc", 1);
			for (const [kind, placement] of scenario.events) {
				coordinator[kind]("doc", placement);
			}
			for (const task of tasks) if (!cancelled.has(task)) task();
			// Late events after resolution are ignored as part of the same drag.
			coordinator.zone("doc", root);
			coordinator.header("doc", folder);
			for (const task of tasks) if (!cancelled.has(task)) task();
			expect(writes).toEqual([scenario.expected]);
		});
	}

	test("retains an unresolved source id for a delayed category-root header drop", () => {
		const writes: Array<[string, SidebarDocumentPlacement]> = [];
		const zoneTasks: Array<() => void> = [];
		const expiryTasks: Array<() => void> = [];
		const cancelled = new Set<() => void>();
		const coordinator = createDocumentDropCoordinator({
			persist: (id, placement) => writes.push([id, placement]),
			defer: (callback) => {
				zoneTasks.push(callback);
				return callback as unknown as ReturnType<typeof setTimeout>;
			},
			cancel: (handle) => cancelled.add(handle as unknown as () => void),
			expire: (callback) => {
				expiryTasks.push(callback);
				return callback as unknown as ReturnType<typeof setTimeout>;
			},
			cancelExpire: (handle) => cancelled.add(handle as unknown as () => void),
		});
		coordinator.begin("doc-from-folder", 1);
		// Model the source fallback being queued before the native header event.
		coordinator.zone("doc-from-folder", root);
		coordinator.end("doc-from-folder", 1);

		// The source dndzone finalize has already cleared FolderTree's local
		// draggedDocId. The native header drop is delivered in a later event turn.
		expect(coordinator.pendingId(1)).toBe("doc-from-folder");
		const delayedId = coordinator.pendingId(1);
		if (delayedId) coordinator.header(delayedId, category);
		for (const task of zoneTasks) if (!cancelled.has(task)) task();
		for (const task of expiryTasks) if (!cancelled.has(task)) task();

		expect(writes).toEqual([["doc-from-folder", category]]);
		expect(coordinator.pendingId(1)).toBeNull();
	});

	test("expires cancelled drags and never reuses their document id", () => {
		const expiryTasks: Array<() => void> = [];
		const writes: string[] = [];
		const coordinator = createDocumentDropCoordinator({
			persist: (id) => writes.push(id),
			expire: (callback) => {
				expiryTasks.push(callback);
				return callback as unknown as ReturnType<typeof setTimeout>;
			},
		});
		coordinator.begin("cancelled-doc", 4);
		coordinator.end("cancelled-doc", 4);
		for (const task of expiryTasks) task();
		coordinator.header("cancelled-doc", category);
		coordinator.zone("unrelated-doc", root);

		expect(coordinator.pendingId(4)).toBeNull();
		expect(coordinator.pendingId(5)).toBeNull();
		expect(writes).toEqual([]);
	});

	test("a new drag token supersedes the prior unresolved transaction", () => {
		const writes: string[] = [];
		const coordinator = createDocumentDropCoordinator({
			persist: (id) => writes.push(id),
		});
		coordinator.begin("old-doc", 8);
		coordinator.begin("new-doc", 9);

		expect(coordinator.pendingId(8)).toBeNull();
		expect(coordinator.pendingId(9)).toBe("new-doc");
		coordinator.header("new-doc", category);
		expect(writes).toEqual(["new-doc"]);
	});

	test("category root targets always detach the document from its folder", () => {
		const writes: SidebarDocumentPlacement[] = [];
		const coordinator = createDocumentDropCoordinator({
			persist: (_id, placement) => writes.push(placement),
		});

		for (const [id, target] of [
			["folder-to-category", "category-b"],
			["uncategorized-to-category", "category-a"],
			["category-a-to-category-b", "category-b"],
		] as const) {
			coordinator.begin(id, 1);
			coordinator.header(id, { folderId: null, categoryId: target });
		}

		expect(writes).toEqual([
			{ folderId: null, categoryId: "category-b" },
			{ folderId: null, categoryId: "category-a" },
			{ folderId: null, categoryId: "category-b" },
		]);
	});

	test("Uncategorized header detaches both category and folder", () => {
		const writes: SidebarDocumentPlacement[] = [];
		const coordinator = createDocumentDropCoordinator({
			persist: (_id, placement) => writes.push(placement),
		});
		coordinator.begin("categorized-folder-doc", 2);
		coordinator.header("categorized-folder-doc", root);
		expect(writes).toEqual([{ folderId: null, categoryId: null }]);
	});
});
