type ValidatorOptions = Readonly<{
	root?: URL;
	tag: string;
}>;

const manifestPaths = [
	"package.json",
	"package.public.json",
	"backend/package.json",
	"frontend/package.json",
	"packages/cli/package.json",
	"packages/db/package.json",
	"packages/mcp-server/package.json",
	"packages/sdk/package.json",
] as const;

const runtimeVersionSources = [
	{ path: "backend/src/index.ts", pattern: /version:\s*"([^"]+)"/ },
	{ path: "packages/cli/src/index.ts", pattern: /VERSION\s*=\s*'([^']+)'/ },
	{ path: "packages/mcp-server/src/server.ts", pattern: /version:\s*'([^']+)'/ },
	{ path: "frontend/vite.config.ts", pattern: /docsmint-oss-([0-9A-Za-z.+-]+)/ },
	{ path: "docker-compose.yml", pattern: /docsmint-oss-([0-9A-Za-z.+-]+)/ },
] as const;

function versionFromTag(tag: string): string {
	const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(
		tag,
	);
	if (!match?.[1]) throw new Error(`Invalid release tag: ${tag}`);
	return match[1];
}

async function readJson(url: URL): Promise<Record<string, unknown>> {
	const value = (await Bun.file(url).json()) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Expected an object in ${url.pathname}`);
	}
	return value as Record<string, unknown>;
}

function recordMismatch(mismatches: string[], source: string, actual: unknown, expected: string): void {
	if (actual !== expected) mismatches.push(`${source}=${String(actual)}`);
}

export async function validateReleaseVersion({
	root = new URL("../", import.meta.url),
	tag,
}: ValidatorOptions): Promise<void> {
	const expected = versionFromTag(tag);
	const mismatches: string[] = [];

	for (const path of manifestPaths) {
		recordMismatch(mismatches, path, (await readJson(new URL(path, root))).version, expected);
	}

	const lockfile = await Bun.file(new URL("bun.lock", root)).text();
	const workspaceBlock = lockfile.slice(0, lockfile.indexOf('  "packages": {'));
	const workspaceVersions = [
		...workspaceBlock.matchAll(/^\s*"version": "([^"]+)"/gm),
	].map((match) => match[1]);
	if (workspaceVersions.length !== 7) {
		mismatches.push(`bun.lock workspace versions=${workspaceVersions.length}`);
	}
	for (const version of workspaceVersions) {
		recordMismatch(mismatches, "bun.lock workspace", version, expected);
	}

	const server = await readJson(new URL("server.json", root));
	recordMismatch(mismatches, "server.json version", server.version, expected);
	const serverPackages = server.packages;
	if (!Array.isArray(serverPackages) || serverPackages.length !== 1) {
		mismatches.push("server.json packages");
	} else {
		recordMismatch(
			mismatches,
			"server.json npm package version",
			(serverPackages[0] as Record<string, unknown>).version,
			expected,
		);
	}

	const openApi = await readJson(new URL("docs/openapi.json", root));
	const openApiInfo = openApi.info;
	if (!openApiInfo || typeof openApiInfo !== "object" || Array.isArray(openApiInfo)) {
		mismatches.push("docs/openapi.json info");
	} else {
		recordMismatch(
			mismatches,
			"docs/openapi.json info.version",
			(openApiInfo as Record<string, unknown>).version,
			expected,
		);
	}

	for (const source of runtimeVersionSources) {
		const match = source.pattern.exec(await Bun.file(new URL(source.path, root)).text());
		recordMismatch(mismatches, source.path, match?.[1], expected);
	}

	if (mismatches.length > 0) {
		throw new Error(
			`Release version mismatch for ${tag}; expected ${expected}: ${mismatches.join(", ")}`,
		);
	}
}

if (import.meta.main) {
	try {
		await validateReleaseVersion({ tag: Bun.argv[2] ?? "" });
		console.log(`Release version metadata matches ${Bun.argv[2]}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
