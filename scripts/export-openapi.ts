#!/usr/bin/env bun
/**
 * Export OpenAPI spec from the running hiai-docs API.
 * Usage: bun run scripts/export-openapi.ts
 *
 * The API server must be running (default: http://localhost:50700).
 * Output: docs/openapi.json
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const API_URL = process.env.API_URL ?? "http://localhost:50700";
const OUTPUT_PATH = join(import.meta.dir, "..", "docs", "openapi.json");
const INVENTORY_PATH = join(
  import.meta.dir,
  "..",
  "docs",
  "http-route-inventory.json",
);
const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);

async function exportSpec() {
  console.log(`Fetching OpenAPI spec from ${API_URL}/api/docs/json ...`);

  const response = await fetch(`${API_URL}/api/docs/json`);
  if (!response.ok) {
    console.error(`Failed to fetch spec: ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const spec = await response.json();

  mkdirSync(join(import.meta.dir, "..", "docs"), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(spec, null, 2) + "\n");
  const routes = Object.entries(
    (spec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {},
  )
    .flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => HTTP_METHODS.has(method.toLowerCase()))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
  writeFileSync(INVENTORY_PATH, JSON.stringify(routes, null, 2) + "\n");

  console.log(`OpenAPI spec exported to ${OUTPUT_PATH}`);
  console.log(`Route inventory exported to ${INVENTORY_PATH}`);
  console.log(`Endpoints: ${routes.length} operations`);
}

exportSpec().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
