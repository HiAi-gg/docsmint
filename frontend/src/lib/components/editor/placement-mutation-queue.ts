export interface DocumentPlacement {
	folderId: string | null;
	categoryId: string | null;
}

/** Serializes placement writes so a slower earlier PATCH cannot win last. */
export interface PlacementMutationQueue {
	(placement: DocumentPlacement): Promise<void>;
	getConfirmedPlacement(): DocumentPlacement;
	resetConfirmedPlacement(placement: DocumentPlacement): void;
}

export function createPlacementMutationQueue(
	mutate: (placement: DocumentPlacement) => Promise<unknown>,
	initialPlacement: DocumentPlacement = { folderId: null, categoryId: null },
): PlacementMutationQueue {
	let chain: Promise<void> = Promise.resolve();
	let confirmedPlacement = { ...initialPlacement };

	const enqueue = (placement: DocumentPlacement) => {
		const request = chain.then(async () => {
			await mutate(placement);
			confirmedPlacement = { ...placement };
		});
		chain = request.catch(() => undefined);
		return request;
	};
	enqueue.getConfirmedPlacement = () => ({ ...confirmedPlacement });
	enqueue.resetConfirmedPlacement = (placement: DocumentPlacement) => {
		confirmedPlacement = { ...placement };
	};
	return enqueue;
}
