import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function parseConfig(source: string): Map<string, string> {
	return new Map(
		source
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => {
				const separator = line.indexOf("=");
				return [line.slice(0, separator), line.slice(separator + 1)];
			}),
	);
}

describe("quickstart provider configuration", () => {
	test("preserves existing advanced OpenRouter provider overrides", async () => {
		const root = mkdtempSync(join(tmpdir(), "docsmint-quickstart-"));
		temporaryRoots.push(root);
		const scriptsDir = join(root, "scripts");
		const binDir = join(root, "bin");
		mkdirSync(scriptsDir);
		mkdirSync(binDir);

		const configPath = join(root, "quickstart-config");
		writeFileSync(
			configPath,
			[
				"DB_PASSWORD=db-password",
				"HIAI_APP_PASSWORD=app-password",
				"BETTER_AUTH_SECRET=better-auth-secret",
				"CSRF_SECRET=csrf-secret",
				"WEBHOOK_SECRET=webhook-secret",
				"STORAGE_SECRET_KEY=storage-secret",
				"HIAI_DOCS_API_KEY=admin-secret",
				"API_KEY_HASH_SECRET=hash-secret",
				"API_KEY_ENCRYPTION_SECRET=encryption-secret",
				"OWNER_ID=10000000-0000-4000-8000-000000000001",
				"DB_NAME=hiai_docs",
				"DB_PORT=5437",
				"AI_PROVIDER=openrouter",
				"OLLAMA_PORT=11434",
				"OPENROUTER_API_KEY=test-provider-key",
				"EMBEDDING_BASE_URL=https://embedding.example/v1",
				"EMBEDDING_MODEL=custom-embedding-model",
				"EMBEDDING_FALLBACK_BASE_URL=https://embedding-fallback.example/v1",
				"EMBEDDING_FALLBACK_MODEL=custom-embedding-fallback",
				"GRAPH_EXTRACT_BASE_URL=https://graph.example/v1",
				"GRAPH_EXTRACT_MODEL=custom-graph-model",
				"GRAPH_EXTRACT_FALLBACK_BASE_URL=https://graph-fallback.example/v1",
				"GRAPH_EXTRACT_FALLBACK_MODEL=custom-graph-fallback",
				"SEARCH_EXPANSION_BASE_URL=https://search.example/v1",
				"SEARCH_EXPANSION_MODEL=custom-search-model",
				"SEARCH_EXPANSION_FALLBACK_BASE_URL=https://search-fallback.example/v1",
				"SEARCH_EXPANSION_FALLBACK_MODEL=custom-search-fallback",
			].join("\n"),
		);

		const original = await Bun.file(join(import.meta.dir, "quickstart.sh")).text();
		const executable = original.replace(
			'ENV_FILE="${ROOT_DIR}/.env"',
			'ENV_FILE="${DOCSMINT_TEST_CONFIG:?}"',
		);
		const scriptPath = join(scriptsDir, "quickstart.sh");
		writeFileSync(scriptPath, executable);
		chmodSync(scriptPath, 0o755);
		const dockerPath = join(binDir, "docker");
		writeFileSync(dockerPath, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(dockerPath, 0o755);

		const result = Bun.spawnSync({
			cmd: ["bash", scriptPath],
			env: {
				...process.env,
				DOCSMINT_TEST_CONFIG: configPath,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);

		const values = parseConfig(readFileSync(configPath, "utf8"));
		expect(values.get("EMBEDDING_BASE_URL")).toBe(
			"https://embedding.example/v1",
		);
		expect(values.get("EMBEDDING_MODEL")).toBe("custom-embedding-model");
		expect(values.get("GRAPH_EXTRACT_BASE_URL")).toBe(
			"https://graph.example/v1",
		);
		expect(values.get("GRAPH_EXTRACT_MODEL")).toBe("custom-graph-model");
		expect(values.get("SEARCH_EXPANSION_BASE_URL")).toBe(
			"https://search.example/v1",
		);
		expect(values.get("SEARCH_EXPANSION_MODEL")).toBe("custom-search-model");
	});
});
