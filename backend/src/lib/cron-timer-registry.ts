export interface CronTimerRegistry {
	register(handle: ReturnType<typeof setInterval>): void;
	close(): void;
}

export function createCronTimerRegistry(
	clear: (handle: ReturnType<typeof setInterval>) => void = clearInterval,
): CronTimerRegistry {
	const handles: Array<ReturnType<typeof setInterval>> = [];
	let closed = false;
	return {
		register(handle) {
			if (closed) {
				clear(handle);
				return;
			}
			handles.push(handle);
		},
		close() {
			if (closed) return;
			closed = true;
			for (const handle of handles) clear(handle);
			handles.length = 0;
		},
	};
}
