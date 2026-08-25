export const ACCOUNT_PURGE_FENCED_CODE = "ACCOUNT_PURGE_FENCED";
export const ACCOUNT_PURGE_FENCED_MESSAGE = "Account deletion is in progress";

type DatabaseErrorLike = Readonly<{
	code?: unknown;
	constraint_name?: unknown;
	constraint?: unknown;
	message?: unknown;
	cause?: unknown;
}>;

/** Match only the database's stable purge-fence signature, including wrappers. */
export function isAccountPurgeFencedError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 4; depth += 1) {
		if (typeof current !== "object" || current === null) return false;
		const candidate = current as DatabaseErrorLike;
		if (
			candidate.code === "55000" &&
			(candidate.constraint_name === "account_purge_fenced" ||
				candidate.constraint === "account_purge_fenced" ||
				candidate.message === "account_purge_fenced")
		) {
			return true;
		}
		current = candidate.cause;
	}
	return false;
}

export function accountPurgeFencedResponse(): {
	error: string;
	code: typeof ACCOUNT_PURGE_FENCED_CODE;
} {
	return {
		error: ACCOUNT_PURGE_FENCED_MESSAGE,
		code: ACCOUNT_PURGE_FENCED_CODE,
	};
}
