import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeExecutable(path: string, source: string): void {
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}

describe("stack health script", () => {
	test("does not require Ollama for an OpenRouter deployment", () => {
		const root = mkdtempSync(join(tmpdir(), "docsmint-health-check-"));
		temporaryRoots.push(root);
		const binDir = join(root, "bin");
		mkdirSync(binDir);
		writeExecutable(
			join(binDir, "curl"),
			'#!/usr/bin/env sh\ncase "$*" in *"/api/tags"*) exit 1;; *) exit 0;; esac\n',
		);
		writeExecutable(join(binDir, "psql"), "#!/usr/bin/env sh\nexit 0\n");
		writeExecutable(
			join(binDir, "redis-cli"),
			"#!/usr/bin/env sh\nexit 0\n",
		);

		const result = Bun.spawnSync({
			cmd: ["bash", join(import.meta.dir, "health-check.sh")],
			env: {
				...process.env,
				AI_PROVIDER: "openrouter",
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).not.toContain("❌ Ollama");
	});
});
