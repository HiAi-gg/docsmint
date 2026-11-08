#!/usr/bin/env bun
/**
 * Export OpenAPI spec from the running hiai-docs API.
 * Usage: bun run scripts/export-openapi.ts
 *
 * The API server must be running (default: http://localhost:50700).
 * Output: docs/openapi.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enrichOpenApi, openApiRuntimeInventory } from "./enrich-openapi";

const API_URL = process.env.API_URL ?? "http://localhost:50700";
const OUTPUT_PATH = join(import.meta.dir, "..", "docs", "openapi.json");
const INVENTORY_PATH = join(
	import.meta.dir,
	"..",
	"docs",
	"http-route-inventory.json",
);
async function exportSpec() {
	console.log(`Fetching OpenAPI spec from ${API_URL}/api/docs/json ...`);

	const response = await fetch(`${API_URL}/api/docs/json`);
	if (!response.ok) {
		console.error(
			`Failed to fetch spec: ${response.status} ${response.statusText}`,
		);
		process.exit(1);
	}

	const spec = enrichOpenApi(await response.json());

	mkdirSync(join(import.meta.dir, "..", "docs"), { recursive: true });
	writeFileSync(OUTPUT_PATH, `${JSON.stringify(spec, null, 2)}\n`);
	const routes = openApiRuntimeInventory(spec);
	writeFileSync(INVENTORY_PATH, `${JSON.stringify(routes, null, 2)}\n`);

	console.log(`OpenAPI spec exported to ${OUTPUT_PATH}`);
	console.log(`Route inventory exported to ${INVENTORY_PATH}`);
	console.log(`Endpoints: ${routes.length} operations`);
}

exportSpec().catch((err) => {
	console.error("Export failed:", err);
	process.exit(1);
});
