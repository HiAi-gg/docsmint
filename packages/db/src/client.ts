import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://aiuser:aipassword@localhost:5433/hiai_docs";

const client = postgres(databaseUrl, { max: 20, idle_timeout: 30, connect_timeout: 10 });
export const db = drizzle(client, { schema });
