import { expect, test } from "bun:test";
import { createDocumentAutosave } from "./document-autosave";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("navigation flush keeps the document ID captured with the edit", async () => {
	const writes: string[] = [];
	const queue = createDocumentAutosave<string>({
		mutate: async (id, content) => {
			writes.push(`${id}:${content}`);
		},
	});
	let currentId = "A";
	queue.schedule(currentId, "edited A");
	currentId = "B";
	await queue.flush();
	expect(currentId).toBe("B");
	expect(writes).toEqual(["A:edited A"]);
});

test("retries stay bound to the original document after a switch", async () => {
	const backoff = deferred();
	const entered = deferred();
	const writes: string[] = [];
	let attempts = 0;
	const queue = createDocumentAutosave<string>({
		mutate: async (id, content) => {
			if (++attempts === 1) throw new Error("429");
			writes.push(`${id}:${content}`);
		},
		shouldRetry: () => true,
		sleep: async () => {
			entered.resolve();
			await backoff.promise;
		},
	});
	queue.schedule("A", "from A");
	const flushed = queue.flush();
	await entered.promise;
	queue.schedule("B", "from B");
	backoff.resolve();
	await flushed;
	expect(writes).toEqual(["A:from A", "B:from B"]);
});

test("coalesces newer edits during retry backoff and never commits stale content last", async () => {
	const backoff = deferred();
	const entered = deferred();
	const writes: string[] = [];
	let attempts = 0;
	const queue = createDocumentAutosave<string>({
		mutate: async (_id, content) => {
			if (++attempts === 1) throw new Error("429");
			writes.push(content);
		},
		shouldRetry: () => true,
		sleep: async () => {
			entered.resolve();
			await backoff.promise;
		},
	});
	queue.schedule("A", "old");
	const flushed = queue.flush();
	await entered.promise;
	queue.schedule("A", "intermediate");
	queue.schedule("A", "new");
	backoff.resolve();
	await flushed;
	expect(writes).toEqual(["new"]);
});

test("serializes in-flight writes and reports saved only for the newest edit", async () => {
	const gate = deferred();
	const entered = deferred();
	const writes: string[] = [];
	const saved: string[] = [];
	const queue = createDocumentAutosave<string>({
		mutate: async (_id, content) => {
			if (content === "old") {
				entered.resolve();
				await gate.promise;
			}
			writes.push(content);
		},
		onStatus: (id, status) => {
			if (status === "saved") saved.push(id);
		},
	});
	queue.schedule("A", "old");
	const flushed = queue.flush();
	await entered.promise;
	queue.schedule("A", "new");
	gate.resolve();
	await flushed;
	expect(writes).toEqual(["old", "new"]);
	expect(saved).toEqual(["A"]);
});

test("dispose flushes pending work without notifying a destroyed component", async () => {
	const writes: string[] = [];
	const statuses: string[] = [];
	const queue = createDocumentAutosave<string>({
		mutate: async (id) => {
			writes.push(id);
		},
		onStatus: (_id, status) => {
			statuses.push(status);
		},
	});
	queue.schedule("A", "text");
	const before = statuses.length;
	await queue.dispose();
	expect(writes).toEqual(["A"]);
	expect(statuses).toHaveLength(before);
});

test("failed saves remain dirty and explicit flush can retry without losing the edit", async () => {
	let attempts = 0;
	const errors: string[] = [];
	const queue = createDocumentAutosave<string>({
		mutate: async () => {
			if (++attempts === 1) throw new Error("network unavailable");
		},
		onError: (id) => {
			errors.push(id);
		},
	});
	queue.schedule("A", "unsaved text");
	expect(await queue.flush()).toBe(false);
	expect(queue.dirty).toBe(true);
	expect(errors).toEqual(["A"]);
	expect(await queue.flush()).toBe(true);
	expect(queue.dirty).toBe(false);
});

test("navigation waits for a successful save and stays on the editor after failure", async () => {
	const source = await Bun.file(
		new URL("../../../routes/(app)/docs/[id]/+page.svelte", import.meta.url),
	).text();
	const start = source.indexOf("let savingBeforeNavigation = false;");
	const end = source.indexOf("onDestroy(() =>", start);
	const navigationCode = source.slice(start, end);
	const gate = deferred();
	let callback!: (navigation: {
		cancel: () => void;
		willUnload: boolean;
		to: { url: URL };
		type: string;
	}) => void;
	let fail = false;
	const queue = createDocumentAutosave<string>({
		mutate: async () => {
			await gate.promise;
			if (fail) throw new Error("offline");
		},
	});
	const destinations: string[] = [];
	new Function(
		"beforeNavigate",
		"contentAutosave",
		"goto",
		"history",
		navigationCode,
	)(
		(handler: typeof callback) => {
			callback = handler;
		},
		queue,
		async (url: URL) => {
			destinations.push(url.pathname);
		},
		{},
	);
	let cancelled = 0;
	const navigation = {
		cancel: () => {
			cancelled++;
		},
		willUnload: false,
		to: { url: new URL("https://example.invalid/docs/B") },
		type: "link",
	};
	queue.schedule("A", "first edit");
	callback(navigation);
	expect(cancelled).toBe(1);
	expect(destinations).toEqual([]);
	gate.resolve();
	await queue.flush();
	await Promise.resolve();
	expect(destinations).toEqual(["/docs/B"]);
	fail = true;
	queue.schedule("A", "second edit");
	callback(navigation);
	await queue.flush();
	await Promise.resolve();
	expect(cancelled).toBe(2);
	expect(destinations).toEqual(["/docs/B"]);
	expect(queue.dirty).toBe(true);
});

test("successful deletion discards pending edits so navigation cannot PATCH the deleted document", async () => {
	let writes = 0;
	const queue = createDocumentAutosave<string>({
		mutate: async () => {
			writes++;
		},
	});
	queue.schedule("A", "pending edit");
	queue.discard("A");
	expect(queue.dirty).toBe(false);
	expect(await queue.flush()).toBe(true);
	expect(writes).toBe(0);
});
