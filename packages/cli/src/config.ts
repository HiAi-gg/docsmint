/**
 * Config loader for the hiai-docs CLI.
 *
 * Resolution order (highest priority first):
 *   1. Environment variables (HIAI_DOCS_URL, HIAI_DOCS_API_KEY)
 *   2. JSON file at ~/.hiai-docs/config.json
 *   3. Built-in defaults
 *
 * The file config persists across invocations, so users can run
 * `hiai-docs config --url <url> --key <key>` once and reuse the
 * values. Env vars are intended for CI/ephemeral contexts where
 * writing to disk is undesirable.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	url: string;
	apiKey: string;
}

const CONFIG_DIR = join(homedir(), ".hiai-docs");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_URL = "http://localhost:50700";

/** Enforce owner-only access for a config directory and its optional file. */
export function enforceConfigPermissions(
	configDir: string,
	configFile: string,
): void {
	if (process.platform === "win32") return;
	if (existsSync(configDir)) chmodSync(configDir, 0o700);
	if (existsSync(configFile)) chmodSync(configFile, 0o600);
}

export function loadConfig(): Config {
	enforceConfigPermissions(CONFIG_DIR, CONFIG_FILE);
	const envUrl = process.env.HIAI_DOCS_URL;
	const envKey = process.env.HIAI_DOCS_API_KEY;

	let file: Partial<Config> = {};
	if (existsSync(CONFIG_FILE)) {
		try {
			const raw = readFileSync(CONFIG_FILE, "utf-8");
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object") {
				file = parsed as Partial<Config>;
			}
		} catch {
			// Corrupted config — fall back to defaults/env. Don't throw:
			// the user should still be able to run `config` to repair it.
			file = {};
		}
	}

	return {
		url: envUrl ?? file.url ?? DEFAULT_URL,
		apiKey: envKey ?? file.apiKey ?? "",
	};
}

export function saveConfig(cfg: Config): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	}
	enforceConfigPermissions(CONFIG_DIR, CONFIG_FILE);
	writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
	// writeFileSync preserves the mode of an existing file, so correct it after
	// every write as well as before reading it.
	enforceConfigPermissions(CONFIG_DIR, CONFIG_FILE);
}

export function configFilePath(): string {
	return CONFIG_FILE;
}
