import { resolve } from "node:path";

const requestedRoot = Bun.argv[2];
if (requestedRoot !== "src" && requestedRoot !== "tests/integration") {
	throw new Error("Expected test root to be src or tests/integration");
}

const backendRoot = resolve(import.meta.dir, "..");
const glob = new Bun.Glob(`${requestedRoot}/**/*.test.ts`);
const files: string[] = [];
const optionalLiveSmokes = new Set([
	"src/__tests__/bullmq-compat.test.ts",
	"src/__tests__/graph-init.test.ts",
	"src/__tests__/openrouter-live-matrix.test.ts",
]);
for await (const file of glob.scan({ cwd: backendRoot, onlyFiles: true })) {
	if (optionalLiveSmokes.has(file)) continue;
	files.push(file);
}
files.sort();
if (files.length === 0)
	throw new Error(`No tests discovered under ${requestedRoot}`);

const unitEnvironment = { ...process.env };
for (const variable of [
	"DATABASE_URL",
	"MIGRATION_DATABASE_URL",
	"REDIS_URL",
	"BULLMQ_SMOKE_REDIS_URL",
	"PIPELINE_RLS_TEST_DATABASE_URL",
	"LIFECYCLE_TEST_DATABASE_URL",
]) {
	delete unitEnvironment[variable];
}

for (const file of files) {
	const child = Bun.spawn(
		[
			"bun",
			"--no-env-file",
			"test",
			"--path-ignore-patterns=*node_modules*",
			file,
		],
		{
			cwd: backendRoot,
			env: unitEnvironment,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const exitCode = await child.exited;
	if (exitCode !== 0) process.exit(exitCode);
}
