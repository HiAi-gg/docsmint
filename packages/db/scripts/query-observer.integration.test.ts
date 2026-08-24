import { describe, expect, test } from "bun:test";

import { createDatabaseClient } from "../src/client";

const databaseUrl = process.env.DOCSMINT_CONTRACT_DATABASE_URL;

describe.skipIf(!databaseUrl)("isolated database query observation", () => {
	test("keeps concurrent observers isolated and preserves client ownership", async () => {
		if (!databaseUrl) throw new Error("DOCSMINT_CONTRACT_DATABASE_URL is required");
		const queriesA: string[] = [];
		const queriesB: string[] = [];
		const observedA = createDatabaseClient(databaseUrl, {
			max: 2,
			queryObserver: ({ query }) => queriesA.push(query),
		});
		const observedB = createDatabaseClient(databaseUrl, {
			max: 2,
			queryObserver: ({ query }) => queriesB.push(query),
		});
		try {
			await Promise.all([
				observedA.client.unsafe("SELECT pg_sleep(0.02), 1 /* observer-a */"),
				observedB.client.unsafe("SELECT pg_sleep(0.01), 2 /* observer-b */"),
			]);

			expect(queriesA.some((query) => query.includes("observer-a"))).toBe(true);
			expect(queriesA.some((query) => query.includes("observer-b"))).toBe(false);
			expect(queriesB.some((query) => query.includes("observer-b"))).toBe(true);
			expect(queriesB.some((query) => query.includes("observer-a"))).toBe(false);

			await observedA.client.end();
			queriesB.length = 0;
			await observedB.client.unsafe("SELECT 5 /* observer-b-after-a-close */");
			expect(queriesB.some((query) => query.includes("observer-b-after-a-close"))).toBe(true);
		} finally {
			await observedA.client.end().catch(() => undefined);
			await observedB.client.end();
		}
	});

	test("contains observer failures and never exposes query parameters", async () => {
		if (!databaseUrl) throw new Error("DOCSMINT_CONTRACT_DATABASE_URL is required");
		const observed = createDatabaseClient(databaseUrl, {
			max: 1,
			queryObserver: (observation) => {
				observations.push(observation);
				throw new Error("observer must not disrupt SQL");
			},
		});
		const observations: object[] = [];
		try {
			const rows = await observed.client.unsafe(
				"SELECT $1::text AS value",
				["private-value"],
			);

			expect(rows).toEqual([{ value: "private-value" }]);
			expect(observations.length).toBeGreaterThan(0);
			for (const observation of observations) {
				expect(observation).not.toHaveProperty("parameters");
			}

			const queryError = await observed.client
				.unsafe("SELECT $1::text FROM task2_missing_relation", ["private-value"])
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(queryError).toBeDefined();
			expect(String(queryError)).not.toContain("private-value");
			expect(String(queryError)).not.toContain("observer must not disrupt SQL");
		} finally {
			await observed.client.end();
		}
	});

	test("does not install PostgreSQL debug instrumentation unless requested", async () => {
		if (!databaseUrl) throw new Error("DOCSMINT_CONTRACT_DATABASE_URL is required");
		const productionNeutral = createDatabaseClient(databaseUrl, { max: 1 });
		const explicitlyObserved = createDatabaseClient(databaseUrl, {
			max: 1,
			queryObserver: () => undefined,
		});
		try {
			expect(productionNeutral.client.options.debug).toBe(false);
			expect(typeof explicitlyObserved.client.options.debug).toBe("function");
			await productionNeutral.client.unsafe("SELECT 1 /* unobserved */");
		} finally {
			await productionNeutral.client.end();
			await explicitlyObserved.client.end();
		}
	});
});
