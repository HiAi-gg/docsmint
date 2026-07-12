export interface SidebarDocumentPlacement {
	folderId: string | null;
	categoryId: string | null;
}

interface PlacementRequest {
	generation: number;
	placement: SidebarDocumentPlacement;
	token: number;
}

export function createDocumentPlacementWriter(options: {
	patch: (id: string, placement: SidebarDocumentPlacement) => Promise<unknown>;
	optimistic: (id: string, placement: SidebarDocumentPlacement) => number;
	acknowledge: (id: string, token: number) => void;
	rollback: (id: string, placement: SidebarDocumentPlacement) => void;
	refresh?: () => Promise<unknown>;
	onError: (error: unknown) => void;
	onRefreshError?: (error: unknown) => void;
}) {
	const states = new Map<
		string,
		{
			chain: Promise<void>;
			confirmed: SidebarDocumentPlacement;
			generation: number;
		}
	>();

	return function move(
		id: string,
		placement: SidebarDocumentPlacement,
		initialConfirmed: SidebarDocumentPlacement,
	): Promise<void> {
		let state = states.get(id);
		if (!state) {
			state = {
				chain: Promise.resolve(),
				confirmed: { ...initialConfirmed },
				generation: 0,
			};
			states.set(id, state);
		}
		const request: PlacementRequest = {
			generation: ++state.generation,
			placement: { ...placement },
			token: options.optimistic(id, placement),
		};
		const run = state.chain.then(async () => {
			try {
				await options.patch(id, request.placement);
				state.confirmed = { ...request.placement };
				options.acknowledge(id, request.token);
				// A committed PATCH must never be rolled back because a list refresh
				// failed. Refresh is only a best-effort reconciliation step.
				if (options.refresh) {
					void options
						.refresh()
						.catch(options.onRefreshError ?? (() => undefined));
				}
			} catch (error) {
				options.acknowledge(id, request.token);
				if (request.generation === state.generation) {
					options.rollback(id, state.confirmed);
				}
				options.onError(error);
				throw error;
			}
		});
		state.chain = run.catch(() => undefined);
		return run;
	};
}

export function createDocumentDropCoordinator(options: {
	persist: (id: string, placement: SidebarDocumentPlacement) => void;
	defer?: (callback: () => void) => ReturnType<typeof setTimeout>;
	cancel?: (handle: ReturnType<typeof setTimeout>) => void;
	expire?: (callback: () => void) => ReturnType<typeof setTimeout>;
	cancelExpire?: (handle: ReturnType<typeof setTimeout>) => void;
}) {
	const defer = options.defer ?? ((callback) => setTimeout(callback, 0));
	const cancel = options.cancel ?? clearTimeout;
	const expire = options.expire ?? ((callback) => setTimeout(callback, 1000));
	const cancelExpire = options.cancelExpire ?? clearTimeout;
	let active:
		| {
				id: string;
				token: number;
				resolved: boolean;
				pending: ReturnType<typeof setTimeout> | null;
				expiry: ReturnType<typeof setTimeout> | null;
		  }
		| undefined;

	function clearActive() {
		if (active?.pending) cancel(active.pending);
		if (active?.expiry) cancelExpire(active.expiry);
		active = undefined;
	}

	function lookup(id: string) {
		return active?.id === id ? active : undefined;
	}

	return {
		/**
		 * Returns the document whose drag transaction is still awaiting a
		 * destination. UI state may already have been cleared by the source
		 * zone's finalize event before a category-header drop is delivered.
		 */
		pendingId(token: number) {
			return active && !active.resolved && active.token === token
				? active.id
				: null;
		},
		begin(id: string, token: number) {
			if (active?.id === id && active.token === token) return;
			clearActive();
			active = { id, token, resolved: false, pending: null, expiry: null };
		},
		end(id: string, token: number) {
			const transaction = active;
			if (
				!transaction ||
				transaction.id !== id ||
				transaction.token !== token ||
				transaction.resolved ||
				transaction.expiry
			) {
				return;
			}
			transaction.expiry = expire(() => {
				if (active === transaction && !transaction.resolved) clearActive();
			});
		},
		cancel() {
			clearActive();
		},
		zone(id: string, placement: SidebarDocumentPlacement) {
			const transaction = lookup(id);
			if (!transaction || transaction.resolved) return;
			if (transaction.pending) cancel(transaction.pending);
			transaction.pending = defer(() => {
				if (active === transaction && !transaction.resolved) {
					transaction.pending = null;
					if (transaction.expiry) {
						cancelExpire(transaction.expiry);
						transaction.expiry = null;
					}
					transaction.resolved = true;
					options.persist(id, placement);
				}
			});
		},
		header(id: string, placement: SidebarDocumentPlacement) {
			const transaction = lookup(id);
			if (!transaction || transaction.resolved) return;
			if (transaction.pending) cancel(transaction.pending);
			transaction.pending = null;
			if (transaction.expiry) cancelExpire(transaction.expiry);
			transaction.expiry = null;
			transaction.resolved = true;
			options.persist(id, placement);
		},
	};
}
