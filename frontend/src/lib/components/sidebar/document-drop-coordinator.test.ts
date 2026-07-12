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
});
