import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const projectEnvUrl = new URL("../../../.env", import.meta.url);

export interface MigrationOptions {
	/** Explicit owner connection URL. Runtime DATABASE_URL is never used. */
	ownerUrl?: string;
	/** Override migration folder for tests or embedded runners. */
	migrationsFolder?: string;
	/** Environment source, injectable for deterministic tests. */
	env?: Record<string, string | undefined>;
}

function parseEnvFile(contents: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	return values;
}

async function loadProjectEnv(): Promise<Record<string, string>> {
	const envFile = Bun.file(projectEnvUrl);
	return (await envFile.exists()) ? parseEnvFile(await envFile.text()) : {};
}

/**
 * Resolve the migration-owner URL. `DATABASE_URL` intentionally is not a
 * fallback: it belongs to the runtime role (`hiai_app`) and must not run DDL.
 */
export async function resolveMigrationOwnerUrl(
	options: Pick<MigrationOptions, "ownerUrl" | "env"> = {},
): Promise<string> {
	const env = options.env ?? process.env;
	// An injected environment is a complete configuration boundary. This is
	// important for tests and embedded runners: a developer's project `.env`
	// must never silently override the environment supplied by the caller.
	const fileEnv = options.env === undefined ? await loadProjectEnv() : {};
	const url =
		options.ownerUrl?.trim() ||
		env.MIGRATION_DATABASE_URL?.trim() ||
		fileEnv.MIGRATION_DATABASE_URL?.trim();
	if (!url) {
		throw new Error(
			"MIGRATION_DATABASE_URL is required for database migrations; DATABASE_URL is runtime-only",
		);
	}
	return url;
}

export async function runMigrations(ownerUrl: string, options: Pick<MigrationOptions, "migrationsFolder"> = {}): Promise<void> {
	if (!ownerUrl.trim()) throw new Error("Migration owner URL must not be empty");
	const client = postgres(ownerUrl, { max: 1 });
	try {
		await migrate(drizzle(client), {
			migrationsFolder:
				options.migrationsFolder ?? new URL("../src/migrations", import.meta.url).pathname,
		});
	} finally {
		await client.end();
	}
}

export function parseOwnerUrlArg(argv: string[]): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--owner-url" || arg === "--migration-database-url") return argv[index + 1];
		if (arg?.startsWith("--owner-url=")) return arg.slice("--owner-url=".length);
		if (arg?.startsWith("--migration-database-url=")) return arg.slice("--migration-database-url=".length);
	}
	return undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	const ownerUrl = await resolveMigrationOwnerUrl({ ownerUrl: parseOwnerUrlArg(argv) });
	await runMigrations(ownerUrl);
	console.log("Database migrations applied successfully");
}

if (import.meta.main) {
	await main();
}
