export type ContractServiceBindings = Readonly<{
	databaseUrl: string;
	baseUrl: string;
	apiPort: number;
	redisUrl: string;
	storageUrl: string;
}>;

type ContractEnvironment = Readonly<Record<string, string | undefined>>;

const requiredNames = [
	"DOCSMINT_CONTRACT_DATABASE_URL",
	"DATABASE_URL",
	"DOCSMINT_CONTRACT_BASE_URL",
	"API_PORT",
	"DOCSMINT_CONTRACT_REDIS_URL",
	"REDIS_URL",
	"DOCSMINT_CONTRACT_STORAGE_URL",
	"STORAGE_INTERNAL_ENDPOINT_URL",
	"STORAGE_PUBLIC_ENDPOINT_URL",
] as const;

function required(environment: ContractEnvironment, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required for the live contract suite`);
	return value;
}

function normalizedUrl(value: string, name: string): URL {
	try {
		const url = new URL(value);
		if (!url.protocol || !url.hostname) throw new Error("missing origin");
		return url;
	} catch {
		throw new Error(`${name} must be an absolute URL`);
	}
}

function sameEndpoint(left: string, right: string): boolean {
	return normalizedUrl(left, "contract URL").href === normalizedUrl(right, "runtime URL").href;
}

export function resolveContractServiceBindings(
	environment: ContractEnvironment,
): ContractServiceBindings {
	for (const name of requiredNames) required(environment, name);
	const databaseUrl = required(environment, "DOCSMINT_CONTRACT_DATABASE_URL");
	const runtimeDatabaseUrl = required(environment, "DATABASE_URL");
	const baseUrl = required(environment, "DOCSMINT_CONTRACT_BASE_URL").replace(/\/$/, "");
	const apiPortValue = required(environment, "API_PORT");
	const redisUrl = required(environment, "DOCSMINT_CONTRACT_REDIS_URL");
	const runtimeRedisUrl = required(environment, "REDIS_URL");
	const storageUrl = required(environment, "DOCSMINT_CONTRACT_STORAGE_URL").replace(/\/$/, "");
	const internalStorageUrl = required(environment, "STORAGE_INTERNAL_ENDPOINT_URL");
	const publicStorageUrl = required(environment, "STORAGE_PUBLIC_ENDPOINT_URL");

	const apiPort = Number(apiPortValue);
	const base = normalizedUrl(baseUrl, "DOCSMINT_CONTRACT_BASE_URL");
	const redis = normalizedUrl(redisUrl, "DOCSMINT_CONTRACT_REDIS_URL");
	if (!sameEndpoint(databaseUrl, runtimeDatabaseUrl)) {
		throw new Error("Live contract service binding mismatch: PostgreSQL fixture and runtime URLs differ");
	}
	if (!Number.isInteger(apiPort) || apiPort <= 0 || Number(base.port) !== apiPort) {
		throw new Error("Live contract service binding mismatch: base URL and API_PORT differ");
	}
	if (!sameEndpoint(redisUrl, runtimeRedisUrl)) {
		throw new Error("Live contract service binding mismatch: Redis fixture and runtime URLs differ");
	}
	const redisDatabase = Number(redis.pathname.slice(1) || "0");
	if (!Number.isInteger(redisDatabase) || redisDatabase <= 0) {
		throw new Error("Live contract suite requires a dedicated non-default Redis database");
	}
	if (!sameEndpoint(storageUrl, internalStorageUrl)) {
		throw new Error("Live contract service binding mismatch: Seaweed fixture and internal runtime URLs differ");
	}
	if (!sameEndpoint(storageUrl, publicStorageUrl)) {
		throw new Error("Live contract service binding mismatch: Seaweed fixture and public runtime URLs differ");
	}

	return { databaseUrl, baseUrl, apiPort, redisUrl, storageUrl };
}
