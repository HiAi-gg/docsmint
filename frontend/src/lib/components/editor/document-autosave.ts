export type AutosaveStatus = "saved" | "saving" | "unsaved";

interface AutosaveOptions<T> {
	mutate: (documentId: string, update: T) => Promise<unknown>;
	onStatus?: (documentId: string, status: AutosaveStatus) => void;
	onError?: (documentId: string) => void;
	onRetry?: (documentId: string) => void;
	shouldRetry?: (error: unknown) => boolean;
	sleep?: (milliseconds: number) => Promise<void>;
	debounceMs?: number;
}

/** Keep each edit bound to its document, and never let an older request win last. */
export function createDocumentAutosave<T>(options: AutosaveOptions<T>) {
	type Edit = { documentId: string; update: T };
	const pending = new Map<string, Edit>();
	const latest = new Map<string, Edit>();
	const failed = new Map<string, Edit>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let disposed = false;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const status = (edit: Edit, value: AutosaveStatus) => {
		if (!disposed && latest.get(edit.documentId) === edit) {
			options.onStatus?.(edit.documentId, value);
		}
	};

	async function drain() {
		while (pending.size > 0) {
			const edit = pending.values().next().value;
			if (!edit) break;
			pending.delete(edit.documentId);
			status(edit, "saving");
			for (let attempt = 0; attempt < 4; attempt++) {
				if (latest.get(edit.documentId) !== edit) break;
				try {
					await options.mutate(edit.documentId, edit.update);
					failed.delete(edit.documentId);
					status(edit, "saved");
					if (latest.get(edit.documentId) === edit)
						latest.delete(edit.documentId);
					break;
				} catch (error) {
					if (latest.get(edit.documentId) !== edit) break;
					if (attempt < 3 && options.shouldRetry?.(error)) {
						if (!disposed) options.onRetry?.(edit.documentId);
						await sleep(2000 * 2 ** attempt);
						continue;
					}
					failed.set(edit.documentId, edit);
					status(edit, "unsaved");
					if (!disposed) options.onError?.(edit.documentId);
					break;
				}
			}
		}
	}

	async function flush(): Promise<boolean> {
		clearTimeout(timer);
		timer = undefined;
		for (const [id, edit] of failed) {
			if (latest.get(id) === edit) pending.set(id, edit);
		}
		failed.clear();
		if (!running) {
			running = drain().finally(() => {
				running = undefined;
			});
		}
		await running;
		// An edit can arrive while the previous drain is settling.
		if (pending.size > 0) return flush();
		return latest.size === 0;
	}

	return {
		schedule(documentId: string, update: T) {
			if (disposed) return;
			const edit = { documentId, update };
			latest.set(documentId, edit);
			pending.set(documentId, edit);
			failed.delete(documentId);
			status(edit, "unsaved");
			clearTimeout(timer);
			timer = setTimeout(() => {
				void flush();
			}, options.debounceMs ?? 2000);
		},
		flush,
		discard(documentId: string) {
			pending.delete(documentId);
			latest.delete(documentId);
			failed.delete(documentId);
			if (pending.size === 0) clearTimeout(timer);
		},
		get dirty() {
			return latest.size > 0;
		},
		dispose() {
			disposed = true;
			return flush();
		},
	};
}
