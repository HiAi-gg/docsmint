import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPublishedPackage } from "./verify-published-package";

const releaseCommit = "0123456789abcdef0123456789abcdef01234567";
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

type FixtureMutation = Readonly<{
	gitHead?: string;
	integrity?: string;
	manifestVersion?: string;
	omit?: string;
	omitGitHead?: boolean;
	shasum?: string;
}>;

async function packageFixture(mutation: FixtureMutation = {}) {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-provenance-"));
	temporaryDirectories.push(directory);
	const packageRoot = join(directory, "package");
	const files: Record<string, string> = {
		"LICENSE": "Apache-2.0 fixture\n",
		"README.md": "# DocsMint fixture\n",
		"dist/index.d.ts": "export declare const version: string;\n",
		"dist/index.js": 'export const version = "0.7.0";\n',
		"packages/cli/src/index.ts": '#!/usr/bin/env bun\nconsole.log("cli");\n',
		"packages/mcp-server/src/index.ts":
			'#!/usr/bin/env bun\nconsole.log("mcp");\n',
		"server.json": '{"name":"io.github.HiAi-gg/docsmint"}\n',
	};
	const manifest = {
		name: "@hiai-gg/docsmint",
		version: mutation.manifestVersion ?? "0.7.0",
		main: "./dist/index.js",
		types: "./dist/index.d.ts",
		exports: {
			".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
		},
		bin: {
			"hiai-docs": "./packages/cli/src/index.ts",
			"hiai-docs-mcp": "./packages/mcp-server/src/index.ts",
		},
		engines: { bun: ">= 1.3.14" },
	};
	files["package.json"] = `${JSON.stringify(manifest)}\n`;
	for (const [relativePath, contents] of Object.entries(files)) {
		if (relativePath === mutation.omit) continue;
		const path = join(packageRoot, relativePath);
		await mkdir(join(path, ".."), { recursive: true });
		await Bun.write(path, contents);
	}

	const tarballPath = join(directory, "docsmint-0.7.0.tgz");
	const tar = Bun.spawn(["tar", "-czf", tarballPath, "-C", directory, "package"]);
	if ((await tar.exited) !== 0) throw new Error("failed to create package fixture");
	const bytes = new Uint8Array(await Bun.file(tarballPath).arrayBuffer());
	const actualShasum = createHash("sha1").update(bytes).digest("hex");
	const actualIntegrity = `sha512-${createHash("sha512")
		.update(bytes)
		.digest("base64")}`;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname.endsWith(".tgz")) {
				return new Response(bytes);
			}
			if (request.headers.get("accept") !== "application/json") {
				return new Response("full metadata representation required", {
					status: 406,
				});
			}
			return Response.json({
				name: "@hiai-gg/docsmint",
				version: "0.7.0",
				...(mutation.omitGitHead
					? {}
					: { gitHead: mutation.gitHead ?? releaseCommit }),
				dist: {
					tarball: `${server.url.origin}/docsmint-0.7.0.tgz`,
					integrity: mutation.integrity ?? actualIntegrity,
					shasum: mutation.shasum ?? actualShasum,
				},
			});
		},
	});
	return { directory, server, tarballPath };
}

test("verifies exact newly published and already-existing package provenance", async () => {
	const fixture = await packageFixture();
	let consumerTarball = "";
	try {
		for (const publicationPath of ["newly-published", "already-existing"]) {
			const evidenceDirectory = join(fixture.directory, publicationPath);
			const evidence = await verifyPublishedPackage({
				evidenceDirectory,
				packageName: "@hiai-gg/docsmint",
				registryUrl: fixture.server.url.origin,
				releaseCommit,
				releaseTag: "v0.7.0",
				releaseVersion: "0.7.0",
				runCleanConsumer: async (tarballPath) => {
					consumerTarball = tarballPath;
					expect(await Bun.file(tarballPath).exists()).toBeTrue();
				},
			});
			expect(evidence.releaseCommit).toBe(releaseCommit);
			expect(evidence.gitHead).toBe(releaseCommit);
			expect(evidence.cleanConsumer).toBe("passed");
			expect(evidence.files).toContain("package/dist/index.d.ts");
			expect(
				await Bun.file(
					join(evidenceDirectory, `npm-provenance-${releaseCommit}.json`),
				).exists(),
			).toBeTrue();
		}
		expect(consumerTarball).not.toBe(fixture.tarballPath);
	} finally {
		fixture.server.stop(true);
	}
});

test.each([
	["missing gitHead", { omitGitHead: true }, "gitHead"],
	["gitHead", { gitHead: "f".repeat(40) }, "gitHead"],
	["integrity", { integrity: "sha512-bad" }, "integrity"],
	["shasum", { shasum: "0".repeat(40) }, "shasum"],
	["version", { manifestVersion: "0.6.9" }, "manifest version"],
	[
		"required declaration",
		{ omit: "dist/index.d.ts" },
		"advertised package target",
	],
] as const)("fails closed on mutated %s provenance", async (_name, mutation, message) => {
	const fixture = await packageFixture(mutation);
	try {
		await expect(
			verifyPublishedPackage({
				evidenceDirectory: join(fixture.directory, "evidence"),
				packageName: "@hiai-gg/docsmint",
				registryUrl: fixture.server.url.origin,
				releaseCommit,
				releaseTag: "v0.7.0",
				releaseVersion: "0.7.0",
				runCleanConsumer: async () => {},
			}),
		).rejects.toThrow(message);
	} finally {
		fixture.server.stop(true);
	}
});
