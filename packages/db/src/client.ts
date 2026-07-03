import * as schema from "./schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://hiai_app:changeme@localhost:5437/hiai_docs";

const client = postgres(databaseUrl, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db: Database = drizzle(client, { schema });

export { client };
