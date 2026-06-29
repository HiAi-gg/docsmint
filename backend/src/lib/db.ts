import * as schema from "@hiai-docs/db/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config";

const client = postgres(config.DATABASE_URL);
export const db = drizzle(client, { schema });
// Shared raw postgres-js client. Exposed for callers that need to run raw SQL (e.g. Apache AGE cypher() in lib/graph/) that is not covered by the Drizzle query builder. Prefer the typed db client for normal
// application code.
export { client };
