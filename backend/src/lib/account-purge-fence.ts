import { lifecycleOperations } from "@hiai-docs/db/schema";
import { withTenant } from "@hiai-docs/db/with-tenant";
import { and, eq, isNotNull, ne } from "drizzle-orm";

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

/** Canonical route-level translation for the durable database fence. */
export function translateAccountPurgeFencedError(
	error: unknown,
	set: { status?: number | string },
): ReturnType<typeof accountPurgeFencedResponse> | null {
	if (!isAccountPurgeFencedError(error)) return null;
	set.status = 409;
	return accountPurgeFencedResponse();
}

/**
 * Better Auth can perform side effects (for example, sending a change-email
 * verification) before it reaches a guarded users-table write. Check the
 * durable actor fence at the delegated-auth boundary so already-fenced
 * sessions receive the same stable response without starting those effects.
 * Database triggers remain the race-closing authority for every write.
 */
export async function isAccountPurgeFenced(
	actorUserId: string,
): Promise<boolean> {
	return withTenant(
		{ userId: actorUserId, role: "user", source: "personal" },
		async (tx) => {
			const [operation] = await tx
				.select({ id: lifecycleOperations.id })
				.from(lifecycleOperations)
				.where(
					and(
						eq(lifecycleOperations.actorUserId, actorUserId),
						eq(lifecycleOperations.operationKind, "purge"),
						isNotNull(lifecycleOperations.fenceTokenHash),
						ne(lifecycleOperations.status, "rejected"),
					),
				)
				.limit(1);
			return !!operation;
		},
	);
}
