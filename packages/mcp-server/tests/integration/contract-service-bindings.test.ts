import { describe, expect, test } from "bun:test";

import { resolveContractServiceBindings } from "./contract-service-bindings";

const validEnvironment = {
	DOCSMINT_CONTRACT_DATABASE_URL:
		"postgresql://contract:secret@127.0.0.1:5437/hiai_docs_contract",
	DATABASE_URL:
		"postgresql://contract:secret@127.0.0.1:5437/hiai_docs_contract",
	DOCSMINT_CONTRACT_BASE_URL: "http://127.0.0.1:50709",
	API_PORT: "50709",
	DOCSMINT_CONTRACT_REDIS_URL: "redis://127.0.0.1:6384/15",
	REDIS_URL: "redis://127.0.0.1:6384/15",
	DOCSMINT_CONTRACT_STORAGE_URL: "http://127.0.0.1:50702",
	STORAGE_INTERNAL_ENDPOINT_URL: "http://127.0.0.1:50702",
	STORAGE_PUBLIC_ENDPOINT_URL: "http://127.0.0.1:50702",
} as const;

describe("live contract service bindings", () => {
	test("accepts one explicit isolated endpoint per launcher and fixture", () => {
		expect(resolveContractServiceBindings(validEnvironment)).toEqual({
			databaseUrl: validEnvironment.DOCSMINT_CONTRACT_DATABASE_URL,
			baseUrl: validEnvironment.DOCSMINT_CONTRACT_BASE_URL,
			apiPort: 50709,
			redisUrl: validEnvironment.DOCSMINT_CONTRACT_REDIS_URL,
			storageUrl: validEnvironment.DOCSMINT_CONTRACT_STORAGE_URL,
		});
	});

	test("rejects every launcher and fixture endpoint mismatch", () => {
		for (const override of [
			{ DATABASE_URL: "postgresql://contract:secret@127.0.0.1:5437/other" },
			{ API_PORT: "50710" },
			{ REDIS_URL: "redis://127.0.0.1:6384/14" },
			{ STORAGE_INTERNAL_ENDPOINT_URL: "http://127.0.0.1:50703" },
			{ STORAGE_PUBLIC_ENDPOINT_URL: "http://127.0.0.1:50703" },
		]) {
			expect(() =>
				resolveContractServiceBindings({ ...validEnvironment, ...override }),
			).toThrow("Live contract service binding mismatch");
		}
	});

	test("requires a dedicated non-default Redis database", () => {
		expect(() =>
			resolveContractServiceBindings({
				...validEnvironment,
				DOCSMINT_CONTRACT_REDIS_URL: "redis://127.0.0.1:6384/0",
				REDIS_URL: "redis://127.0.0.1:6384/0",
			}),
		).toThrow("dedicated non-default Redis database");
	});
});
