import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.PIPELINE_RLS_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
	"published SDK 2.0.4 performs legacy REST CRUD and folder/tag filtering on the real backend",
	async () => {
		if (!databaseUrl || !process.env.REDIS_URL)
			throw new Error("Dedicated PostgreSQL and Redis fixtures are required");
		const directory = await mkdtemp(join(tmpdir(), "docsmint-sdk-204-"));
		const userId = crypto.randomUUID();
		const key = crypto.randomUUID();
		const sql = postgres(databaseUrl, { max: 1 });
		let backend: ReturnType<typeof Bun.spawn> | undefined;
		try {
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({
					private: true,
					type: "module",
					dependencies: { "@hiai-gg/docsmint": "2.0.4" },
				}),
			);
			const install = Bun.spawn(
				[process.execPath, "install", "--ignore-scripts"],
				{ cwd: directory, stdout: "pipe", stderr: "pipe" },
			);
			expect(
				await install.exited,
				await new Response(install.stderr).text(),
			).toBe(0);
			const manifest = await Bun.file(
				join(directory, "node_modules/@hiai-gg/docsmint/package.json"),
			).json();
			expect(manifest.version).toBe("2.0.4");
			await sql`INSERT INTO users (id, name, email, email_verified) VALUES (${userId}, 'Legacy SDK fixture', ${`${userId}@legacy-sdk.invalid`}, true)`;
			const hash = new Bun.CryptoHasher("sha256").update(key).digest("hex");
			await sql`INSERT INTO api_keys (owner_id, name, key_hash, prefix, scopes) VALUES (${userId}, 'Legacy SDK fixture', ${hash}, ${key.slice(0, 8)}, '["global"]'::jsonb)`;
			const reservation = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response(),
			});
			const port = reservation.port;
			reservation.stop(true);
			const baseUrl = `http://127.0.0.1:${port}`;
			// Run the shipped entrypoint, including its real auth, middleware and routes.
			// This suite runs only against the dedicated CI database/Redis services.
			backend = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], {
				cwd: join(import.meta.dir, "../.."),
				env: {
					...process.env,
					DATABASE_URL: databaseUrl,
					NODE_ENV: "test",
					API_PORT: String(port),
					BETTER_AUTH_URL: baseUrl,
					HIAI_DOCS_API_KEY: "",
					OWNER_ID: userId,
					OPENROUTER_API_KEY: "",
					AI_PROVIDER: "ollama",
					EMBEDDING_OLLAMA_URL: "http://127.0.0.1:9",
					SEARCH_EXPANSION_ENABLED: "false",
					SEARCH_RERANK_ENABLED: "false",
				},
				stdout: "ignore",
				stderr: "ignore",
			});
			let ready = false;
			for (let attempt = 0; attempt < 200; attempt++) {
				if (backend.exitCode !== null)
					throw new Error(
						`Backend exited before readiness: ${backend.exitCode}`,
					);
				const response = await fetch(`${baseUrl}/api/documents?limit=1`, {
					headers: { authorization: `Bearer ${key}` },
				}).catch(() => null);
				if (response?.ok) {
					ready = true;
					break;
				}
				await Bun.sleep(100);
			}
			expect(ready).toBe(true);
			const consumer = `
import assert from "node:assert/strict";
import { DocsClient } from "@hiai-gg/docsmint";
const paths = [];
const client = new DocsClient({ baseUrl: process.env.LEGACY_BASE_URL, apiKey: process.env.LEGACY_API_KEY, retries: 0, fetch: (input, init) => { paths.push(new URL(String(input)).pathname); return fetch(input, init); } });
assert.equal((await client.listDocs()).total, 0);
const folder = await client.createFolder({ name: "Legacy folder" });
const tag = await client.createTag({ name: "Legacy tag" });
const doc = await client.createDoc({ title: "Legacy original", content: "", folderId: folder.id });
assert.equal((await client.getDoc(doc.id)).title, "Legacy original");
await client.updateDoc(doc.id, { title: "Legacy updated" });
assert.equal((await client.getDoc(doc.id)).title, "Legacy updated");
await client.addTagToDoc(doc.id, tag.id);
const listed = await client.listDocs({ folderId: folder.id, tag: tag.id, page: 1, limit: 10 });
assert.equal(listed.total, 1); assert.equal(listed.items[0].id, doc.id);
assert.equal(listed.items[0].folderName, "Legacy folder");
assert.equal(typeof listed.items[0].updatedAt, "string");
assert.ok(listed.items[0].tags.some(value => value.id === tag.id));
assert.equal((await client.listDocs({ tag: crypto.randomUUID() })).total, 0);
const cursor = await client.listDocuments({ sortBy: "title", sortOrder: "asc", limit: 1 });
assert.equal(cursor.items[0].id, doc.id); assert.equal(cursor.nextCursor, null);
assert.equal(typeof await client.exportDoc(doc.id), "string");
await client.deleteDoc(doc.id);
assert.equal((await client.listDocs()).total, 0);
assert.ok(paths.length >= 12); assert.ok(paths.every(path => path.startsWith("/api/") && !path.startsWith("/api/v1/")));
console.log("LEGACY_SDK_COMPAT_PASS");
`;
			await writeFile(join(directory, "consumer.mjs"), consumer);
			const run = Bun.spawn(
				[process.execPath, "--no-env-file", "consumer.mjs"],
				{
					cwd: directory,
					env: {
						...process.env,
						LEGACY_BASE_URL: baseUrl,
						LEGACY_API_KEY: key,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, output, error] = await Promise.all([
				run.exited,
				new Response(run.stdout).text(),
				new Response(run.stderr).text(),
			]);
			expect(exitCode, error).toBe(0);
			expect(output).toContain("LEGACY_SDK_COMPAT_PASS");
		} finally {
			if (backend) {
				backend.kill("SIGTERM");
				await backend.exited;
			}
			await sql`DELETE FROM users WHERE id = ${userId}`;
			await sql.end();
			await rm(directory, { recursive: true, force: true });
		}
	},
	180_000,
);
