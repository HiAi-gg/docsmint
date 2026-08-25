import { expect, test } from "bun:test";

import {
	accountPurgeFencedResponse,
	isAccountPurgeFencedError,
} from "./account-purge-fence";

test("recognizes only the stable database purge-fence signature through wrappers", () => {
	expect(
		isAccountPurgeFencedError({
			cause: {
				code: "55000",
				constraint_name: "account_purge_fenced",
				message: "account_purge_fenced",
			},
		}),
	).toBe(true);
	expect(
		isAccountPurgeFencedError({
			code: "55000",
			constraint_name: "unrelated_constraint",
			message: "account_purge_fenced",
		}),
	).toBe(true);
	expect(
		isAccountPurgeFencedError({
			code: "23503",
			constraint_name: "account_purge_fenced",
		}),
	).toBe(false);
	expect(isAccountPurgeFencedError(new Error("account_purge_fenced"))).toBe(
		false,
	);
});

test("returns the stable public account purge response", () => {
	expect(accountPurgeFencedResponse()).toEqual({
		error: "Account deletion is in progress",
		code: "ACCOUNT_PURGE_FENCED",
	});
});
