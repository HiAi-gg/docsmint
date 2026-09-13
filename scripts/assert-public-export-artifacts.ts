/**
 * Built-artifact gate for published package.public.json export paths.
 * Run only after `bun run build:sdk` (or workspace SDK build).
 */
const root = new URL("../", import.meta.url);

function diskUrl(relative: string): URL {
	if (relative.startsWith("./dist/")) {
		return new URL(`packages/sdk/${relative.slice(2)}`, root);
	}
	return new URL(relative, root);
}

export async function assertPublicExportArtifacts(): Promise<void> {
	const published = (await Bun.file(
		new URL("package.public.json", root),
	).json()) as {
		exports: Record<string, unknown>;
		bin: Record<string, string>;
		files: string[];
	};

	const exportEntries = Object.values(published.exports);
	for (const entry of exportEntries) {
		const paths =
			typeof entry === "string"
				? [entry]
				: Object.values(entry as Record<string, string>);
		for (const relative of paths) {
			if (!relative.startsWith("./")) continue;
			const onDisk = diskUrl(relative);
			if (!(await Bun.file(onDisk).exists())) {
				throw new Error(
					`Missing published export artifact: ${relative} (${onDisk.pathname})`,
				);
			}
		}
	}

	for (const relative of [
		"packages/sdk/dist/index.js",
		"packages/sdk/dist/mcp-server.js",
		"packages/sdk/dist/mcp-cli.js",
	]) {
		if (!(await Bun.file(new URL(relative, root)).exists())) {
			throw new Error(`Missing required package artifact: ${relative}`);
		}
	}

	if (published.bin["docsmint-mcp"] !== "./dist/mcp-cli.js") {
		throw new Error("published.bin.docsmint-mcp must be ./dist/mcp-cli.js");
	}
	if (!published.files.includes("dist")) {
		throw new Error('published.files must contain "dist"');
	}
}

if (import.meta.main) {
	await assertPublicExportArtifacts();
}
