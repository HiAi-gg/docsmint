import { describe, expect, test } from "bun:test";
import { createPlacementMutationQueue } from "./placement-mutation-queue";

describe("document placement mutation queue", () => {
	test("persists rapid category and folder changes in user action order", async () => {
		const calls: string[] = [];
		let releaseCategory: (() => void) | undefined;
		const categoryPending = new Promise<void>((resolve) => {
			releaseCategory = resolve;
		});
		const enqueue = createPlacementMutationQueue(async (placement) => {
			calls.push(`start:${placement.folderId ?? "category"}`);
			if (placement.folderId === null) await categoryPending;
			calls.push(`finish:${placement.folderId ?? "category"}`);
		});

		const category = enqueue({ categoryId: "cat-a", folderId: null });
		const folder = enqueue({ categoryId: "cat-a", folderId: "folder-a" });
		await Promise.resolve();

		expect(calls).toEqual(["start:category"]);
		releaseCategory?.();
		await Promise.all([category, folder]);
		expect(calls).toEqual([
			"start:category",
			"finish:category",
			"start:folder-a",
			"finish:folder-a",
		]);
	});

	test("continues with the latest placement after an earlier failure", async () => {
		const calls: string[] = [];
		const enqueue = createPlacementMutationQueue(async (placement) => {
			calls.push(placement.folderId ?? "category");
			if (placement.folderId === null) throw new Error("category failed");
		});

		await expect(
			enqueue({ categoryId: "cat-a", folderId: null }),
		).rejects.toThrow("category failed");
		await enqueue({ categoryId: "cat-a", folderId: "folder-a" });
		expect(calls).toEqual(["category", "folder-a"]);
	});

	test("keeps the last confirmed placement when two optimistic writes fail", async () => {
		const original = { categoryId: "cat-o", folderId: "folder-o" };
		const enqueue = createPlacementMutationQueue(async () => {
			throw new Error("failed");
		}, original);

		const first = enqueue({ categoryId: "cat-a", folderId: null });
		const second = enqueue({ categoryId: "cat-a", folderId: "folder-b" });
		await Promise.allSettled([first, second]);

		expect(enqueue.getConfirmedPlacement()).toEqual(original);
	});
});
