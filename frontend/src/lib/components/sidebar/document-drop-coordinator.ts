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
	refresh: () => Promise<unknown>;
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
				void options
					.refresh()
					.catch(options.onRefreshError ?? (() => undefined));
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
}) {
	const defer = options.defer ?? ((callback) => setTimeout(callback, 0));
	const cancel = options.cancel ?? clearTimeout;
	let active:
		| {
				id: string;
				token: number;
				resolved: boolean;
				pending: ReturnType<typeof setTimeout> | null;
		  }
		| undefined;

	function ensure(id: string) {
		if (!active || active.id !== id) {
			if (active?.pending) cancel(active.pending);
			active = { id, token: -1, resolved: false, pending: null };
		}
		return active;
	}

	return {
		begin(id: string, token: number) {
			if (active?.id === id && active.token === token) return;
			if (active?.pending) cancel(active.pending);
			active = { id, token, resolved: false, pending: null };
		},
		zone(id: string, placement: SidebarDocumentPlacement) {
			const transaction = ensure(id);
			if (transaction.resolved) return;
			if (transaction.pending) cancel(transaction.pending);
			transaction.pending = defer(() => {
				if (active === transaction && !transaction.resolved) {
					transaction.pending = null;
					transaction.resolved = true;
					options.persist(id, placement);
				}
			});
		},
		header(id: string, placement: SidebarDocumentPlacement) {
			const transaction = ensure(id);
			if (transaction.resolved) return;
			if (transaction.pending) cancel(transaction.pending);
			transaction.pending = null;
			transaction.resolved = true;
			options.persist(id, placement);
		},
	};
}
