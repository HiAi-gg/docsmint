import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const projectEnvUrl = new URL("../../../.env", import.meta.url);

if (!process.env.DATABASE_URL) {
	const envFile = Bun.file(projectEnvUrl);
	if (await envFile.exists()) {
		for (const rawLine of (await envFile.text()).split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const separator = line.indexOf("=");
			if (separator <= 0) continue;
			const key = line.slice(0, separator).trim();
			if (key !== "DATABASE_URL") continue;
			let value = line.slice(separator + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			process.env.DATABASE_URL = value;
			break;
		}
	}
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error(
		"DATABASE_URL is required (set it in the environment or project .env)",
	);
}

const client = postgres(databaseUrl, { max: 1 });

try {
	await migrate(drizzle(client), {
		migrationsFolder: new URL("../src/migrations", import.meta.url).pathname,
	});
	console.log("Database migrations applied successfully");
} finally {
	await client.end();
}
