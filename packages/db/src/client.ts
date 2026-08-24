import * as schema from "./schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export type DatabaseQueryObservation = Readonly<{
  query: string;
}>;

export type DatabaseQueryObserver = (
  observation: DatabaseQueryObservation,
) => void;

function observeDatabaseQuery(
  observer: DatabaseQueryObserver | undefined,
  query: string,
): void {
  if (!observer) return;
  try {
    observer(Object.freeze({ query }));
  } catch {
    // Query observation is diagnostic only. Observer bugs must never affect the
    // database protocol, application result, or error surface.
  }
}

export type DatabaseClientOptions = Readonly<{
  max?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  /** Explicit client-local test hook. Omitted clients install no debug callback. */
  queryObserver?: DatabaseQueryObserver;
}>;

export function createDatabaseClient(
  databaseUrl: string,
  options: DatabaseClientOptions = {},
) {
  const sqlClient = postgres(databaseUrl, {
    max: options.max ?? 20,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    ...(options.queryObserver
      ? {
          debug: (_connection: number, query: string) => {
            observeDatabaseQuery(options.queryObserver, query);
          },
        }
      : {}),
  });
  return {
    client: sqlClient,
    db: drizzle(sqlClient, { schema }) as Database,
  };
}

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://hiai_app:changeme@localhost:5437/hiai_docs";

const database = createDatabaseClient(databaseUrl, {
  // Production deliberately owns no query observer. Contract tests create an
  // explicit client-local observer and close that client after each capture.
});

const client = database.client;
export const db: Database = database.db;

export { client };
