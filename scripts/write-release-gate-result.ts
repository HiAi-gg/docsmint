import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const requiredJobs = [
	"lint",
	"typecheck",
	"unit-test",
	"integration-test",
	"scoped-live-integration",
	"build",
	"package-consumer",
	"docker-build",
	"browser-e2e",
	"release-static-gates",
] as const;

export type ReleaseJobResults = Readonly<
	Record<string, Readonly<{ result?: string }>>
>;

export function validateReleaseJobResults(results: ReleaseJobResults): void {
	for (const job of requiredJobs) {
		if (results[job]?.result !== "success") {
			throw new Error(`Release prerequisite did not succeed: ${job}`);
		}
	}
}

async function gitHead(root: string): Promise<string> {
	const process = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error("Unable to resolve release commit");
	return stdout.trim();
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const commit = Bun.env.RELEASE_COMMIT;
	const tag = Bun.env.RELEASE_TAG;
	const serializedResults = Bun.env.RELEASE_JOB_RESULTS;
	if (!commit || !tag || !serializedResults) {
		throw new Error(
			"RELEASE_COMMIT, RELEASE_TAG, and RELEASE_JOB_RESULTS are required",
		);
	}
	if ((await gitHead(root)) !== commit) {
		throw new Error("Release gate result commit does not match checked-out HEAD");
	}
	if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
		throw new Error("Release gate result requires a stable version tag");
	}
	const results = JSON.parse(serializedResults) as ReleaseJobResults;
	validateReleaseJobResults(results);

	const evidenceDirectory = resolve(root, "build/release-evidence");
	await mkdir(evidenceDirectory, { recursive: true });
	await Bun.write(
		resolve(evidenceDirectory, "release-tag-gate.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				commit,
				tag,
				jobs: Object.fromEntries(
					requiredJobs.map((job) => [job, results[job]?.result]),
				),
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Complete release tag gate passed for ${tag} at ${commit}`);
}
