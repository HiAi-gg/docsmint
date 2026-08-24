import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as secretScan from "./secret-scan.ts";

const { findSecretCandidates } = secretScan;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
	);
});

async function temporaryRepository(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-secret-scan-"));
	temporaryDirectories.push(directory);
	for (const args of [
		["init", "--quiet"],
		["config", "user.email", "release-test@example.com"],
		["config", "user.name", "Release Test"],
	]) {
		const result = Bun.spawnSync(["git", ...args], { cwd: directory });
		expect(result.exitCode).toBe(0);
	}
	return directory;
}

test("secret scanning rejects known credential shapes without reporting their values", () => {
	const accessKey = `AKIA${"A".repeat(16)}`;
	const findings = findSecretCandidates([
		{ path: "src/config.ts", source: `export const credential = "${accessKey}";` },
	]);

	expect(findings).toEqual([
		{ path: "src/config.ts", detector: "AWS access key" },
	]);
	expect(JSON.stringify(findings)).not.toContain(accessKey);
});

test("secret scanning accepts placeholders and ordinary source", () => {
	expect(
		findSecretCandidates([
			{ path: ".env.example", source: "OPENROUTER_API_KEY=your-key-here" },
			{ path: "src/config.ts", source: "const mode = 'development';" },
		]),
	).toEqual([]);
});

test("secret scanning rejects modern repository credential classes", () => {
	const githubToken = `github_${`pat_${"A".repeat(82)}`}`;
	const npmToken = `npm_${"B".repeat(36)}`;
	const postgresUrl = `postgresql://release-user:${"C".repeat(32)}@db.example/release`;
	const authSecret = "D".repeat(48);
	const findings = findSecretCandidates([
		{
			path: "src/release.ts",
			source: [
				`const github = "${githubToken}";`,
				`const npm = "${npmToken}";`,
				`const database = "${postgresUrl}";`,
				`BETTER_AUTH_SECRET=${authSecret}`,
			].join("\n"),
		},
	]);

	expect(findings).toEqual([
		{ path: "src/release.ts", detector: "GitHub token" },
		{ path: "src/release.ts", detector: "npm token" },
		{ path: "src/release.ts", detector: "credential-bearing PostgreSQL URL" },
		{ path: "src/release.ts", detector: "repository auth secret" },
	]);
	for (const value of [githubToken, npmToken, postgresUrl, authSecret]) {
		expect(JSON.stringify(findings)).not.toContain(value);
	}
});

test("secret scanning does not skip a credential merely because the blob contains NUL", () => {
	const token = `npm_${"E".repeat(36)}`;
	expect(
		findSecretCandidates([{ path: "asset.bin", source: `header\0${token}\0footer` }]),
	).toEqual([{ path: "asset.bin", detector: "npm token" }]);
});

test("secret scanning accepts documented placeholders and scoped test fixtures", () => {
	expect(
		findSecretCandidates([
			{
				path: ".github/workflows/ci.yml",
				source:
					"BETTER_AUTH_SECRET: ${{ secrets.BETTER_AUTH_SECRET }}\nDATABASE_URL: postgresql://test:test-password@localhost/test",
			},
			{
				path: "backend/src/auth.test.ts",
				source: "BETTER_AUTH_SECRET=test-auth-secret-for-behavior-tests-only",
			},
			{
				path: ".env.example",
				source: [
					"BETTER_AUTH_SECRET=change-me",
					"EMBEDDING_API_KEY=sk-placeholder-not-a-real-provider-key",
					"DATABASE_URL=postgresql://${DB_USER:-app}:${DB_PASSWORD:-change-me}@localhost/db",
				].join("\n"),
			},
			{
				path: "src/config-schema.ts",
				source: [
					"CSRF_SECRET: z.string().min(32),",
					"const WEBHOOK_SECRET = config.WEBHOOK_SECRET;",
				].join("\n"),
			},
			{
				path: "docs/DEPLOYMENT.md",
				source: "`OPENROUTER_API_KEY=<redacted>`",
			},
		]),
	).toEqual([]);
});

test("example and fixture paths do not excuse genuine credential values", () => {
	const authSecret = "aQ7zP2mN9xR4vK8cT6yH3jL5sD1fG0bW";
	const databasePassword = "uP4rS8nV2xC7mK5qW9zD3fH6";
	expect(
		findSecretCandidates([
			{
				path: ".env.example",
				source: `BETTER_AUTH_SECRET=${authSecret}`,
			},
			{
				path: "backend/src/auth.test.ts",
				source: `DATABASE_URL=postgresql://app:${databasePassword}@localhost/db`,
			},
		]),
	).toEqual([
		{ path: ".env.example", detector: "repository auth secret" },
		{
			path: "backend/src/auth.test.ts",
			detector: "credential-bearing PostgreSQL URL",
		},
	]);
});

test("a safe placeholder cannot hide a later real auth-secret assignment", () => {
	const secret = "G".repeat(48);
	expect(
		findSecretCandidates([
			{
				path: "src/config.ts",
				source: `BETTER_AUTH_SECRET=change-me\nCSRF_SECRET=${secret}`,
			},
		]),
	).toEqual([{ path: "src/config.ts", detector: "repository auth secret" }]);
});

test("repository auth-secret assignments in source declarations are detected", () => {
	const secret = "H".repeat(48);
	expect(
		findSecretCandidates([
			{
				path: "src/config.ts",
				source: `const WEBHOOK_SECRET = "${secret}";`,
			},
		]),
	).toEqual([{ path: "src/config.ts", detector: "repository auth secret" }]);
});

test("repository scanning reads immutable tracked blobs, not unreadable worktree files", async () => {
	const scanTrackedRepository = (
		secretScan as unknown as {
			scanTrackedRepository?: (root: string) => Promise<readonly unknown[]>;
		}
	).scanTrackedRepository;
	expect(typeof scanTrackedRepository).toBe("function");
	if (!scanTrackedRepository) return;

	const root = await temporaryRepository();
	const path = join(root, "tracked.txt");
	await Bun.write(path, "safe committed content");
	expect(Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: root }).exitCode).toBe(0);
	await Bun.write(path, `npm_${"F".repeat(36)}`);
	await chmod(path, 0o000);

	await expect(scanTrackedRepository(root)).resolves.toEqual([]);
	await chmod(path, 0o600);
});

test("tracked blob loading fails closed on read failure and excludes only gitlinks", async () => {
	const loadTrackedGitBlobs = (
		secretScan as unknown as {
			loadTrackedGitBlobs?: (
				entries: readonly { path: string; mode: string; oid: string }[],
				readBlob: (oid: string) => Promise<string>,
			) => Promise<readonly unknown[]>;
		}
	).loadTrackedGitBlobs;
	expect(typeof loadTrackedGitBlobs).toBe("function");
	if (!loadTrackedGitBlobs) return;

	await expect(
		loadTrackedGitBlobs(
			[{ path: "tracked.txt", mode: "100644", oid: "deadbeef" }],
			async () => {
				throw new Error("synthetic read failure");
			},
		),
	).rejects.toThrow("Unable to read tracked Git blob: tracked.txt");

	let reads = 0;
	await expect(
		loadTrackedGitBlobs(
			[{ path: "vendor/repository", mode: "160000", oid: "cafebabe" }],
			async () => {
				reads += 1;
				return "ignored";
			},
		),
	).resolves.toEqual([]);
	expect(reads).toBe(0);
});
