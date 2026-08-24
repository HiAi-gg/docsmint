import * as schema from "./schema";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

type ContractQueryObservation = Readonly<{
  query: string;
  parameters: readonly unknown[];
}>;

type ContractQueryObserver = (observation: ContractQueryObservation) => void;

const CONTRACT_QUERY_OBSERVER = Symbol.for(
  "@hiai-gg/docsmint/contract-query-observer",
);

function observeContractQuery(
  query: string,
  parameters: readonly unknown[],
): void {
  const observer = (globalThis as Record<PropertyKey, unknown>)[
    CONTRACT_QUERY_OBSERVER
  ];
  if (typeof observer !== "function") return;
  (observer as ContractQueryObserver)({ query, parameters });
}

const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://hiai_app:changeme@localhost:5437/hiai_docs";

const client = postgres(databaseUrl, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  debug: (_connection, query, parameters) => {
    observeContractQuery(query, parameters);
  },
});

export const db: Database = drizzle(client, { schema });

export { client };
