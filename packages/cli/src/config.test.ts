import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceConfigPermissions } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("CLI config permissions", () => {
	test("corrects an existing directory and config file to owner-only modes", () => {
		if (process.platform === "win32") return;

		const root = mkdtempSync(join(tmpdir(), "hiai-docs-cli-"));
		temporaryDirectories.push(root);
		const configDirectory = join(root, ".hiai-docs");
		const configFile = join(configDirectory, "config.json");
		mkdirSync(configDirectory, { mode: 0o777 });
		writeFileSync(configFile, "{}", { mode: 0o666 });
		chmodSync(configDirectory, 0o777);
		chmodSync(configFile, 0o666);

		enforceConfigPermissions(configDirectory, configFile);

		expect(statSync(configDirectory).mode & 0o777).toBe(0o700);
		expect(statSync(configFile).mode & 0o777).toBe(0o600);
	});
});
