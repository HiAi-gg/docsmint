export interface DocumentPlacement {
	folderId: string | null;
	categoryId: string | null;
}

/** Serializes placement writes so a slower earlier PATCH cannot win last. */
export function createPlacementMutationQueue(
	mutate: (placement: DocumentPlacement) => Promise<unknown>,
): (placement: DocumentPlacement) => Promise<void> {
	let chain: Promise<void> = Promise.resolve();

	return (placement) => {
		const request = chain.then(async () => {
			await mutate(placement);
		});
		chain = request.catch(() => undefined);
		return request;
	};
}
