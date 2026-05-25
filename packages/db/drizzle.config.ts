import type { Config } from "drizzle-kit";

export default {
  out: "./src/migrations",
  schema: "./src/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://aiuser:aipassword@localhost:5433/hiai_docs",
  },
} satisfies Config;
