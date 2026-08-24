import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const commitPattern = /^[0-9a-f]{40}$/;
const requiredPackageFiles = [
	"package/LICENSE",
	"package/README.md",
	"package/package.json",
	"package/server.json",
] as const;

type PublishedMetadata = Readonly<{
	dist?: Readonly<{
		integrity?: unknown;
		shasum?: unknown;
		tarball?: unknown;
	}>;
	gitHead?: unknown;
	name?: unknown;
	version?: unknown;
}>;

export type PublishedPackageEvidence = Readonly<{
	cleanConsumer: "passed";
	distIntegrity: string;
	distShasum: string;
	files: string[];
	gitHead: string;
	packageName: string;
	registryUrl: string;
	releaseCommit: string;
	releaseTag: string;
	releaseVersion: string;
	schemaVersion: 1;
	tarballSha1: string;
	tarballSha512Integrity: string;
	tarballUrl: string;
	verifiedAt: string;
}>;

export type VerifyPublishedPackageOptions = Readonly<{
	evidenceDirectory: string;
	packageName: string;
	registryUrl: string;
	releaseCommit: string;
	releaseTag: string;
	releaseVersion: string;
	runCleanConsumer?: (tarballPath: string) => Promise<void>;
}>;

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`published package ${label} is missing`);
	}
	return value.trim();
}

function collectAdvertisedTargets(value: unknown, targets: Set<string>): void {
	if (typeof value === "string") {
		if (value.startsWith("./")) targets.add(`package/${value.slice(2)}`);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectAdvertisedTargets(entry, targets);
		return;
	}
	if (value && typeof value === "object") {
		for (const entry of Object.values(value)) {
			collectAdvertisedTargets(entry, targets);
		}
	}
}

function verifyIntegrity(bytes: Uint8Array, integrity: string): string {
	const entries = integrity.trim().split(/\s+/);
	for (const entry of entries) {
		const separator = entry.indexOf("-");
		if (separator < 1) continue;
		const algorithm = entry.slice(0, separator);
		if (!(["sha256", "sha384", "sha512"] as const).includes(
			algorithm as "sha256" | "sha384" | "sha512",
		)) {
			continue;
		}
		const expected = entry.slice(separator + 1).split("?")[0];
		const actual = createHash(algorithm).update(bytes).digest("base64");
		if (expected === actual) {
			return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		}
	}
	throw new Error("published package dist.integrity does not match the tarball");
}

async function commandOutput(argv: string[]): Promise<string> {
	const child = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${argv[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`);
	}
	return stdout;
}

async function defaultCleanConsumer(tarballPath: string): Promise<void> {
	const child = Bun.spawn(["bash", "scripts/test-public-package-consumer.sh"], {
		cwd: root,
		env: {
			...Bun.env,
			DOCSMINT_PUBLIC_PACKAGE_TARBALL: tarballPath,
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await child.exited) !== 0) {
		throw new Error("published package clean Bun consumer failed");
	}
}

export async function verifyPublishedPackage(
	options: VerifyPublishedPackageOptions,
): Promise<PublishedPackageEvidence> {
	const releaseCommit = options.releaseCommit.trim().toLowerCase();
	if (!commitPattern.test(releaseCommit)) {
		throw new Error("RELEASE_COMMIT must be the exact 40-character tag commit SHA");
	}
	if (options.releaseTag !== `v${options.releaseVersion}`) {
		throw new Error("release tag and release version do not match");
	}
	const committedManifest = (await Bun.file(
		join(root, "package.public.json"),
	).json()) as { name?: unknown; version?: unknown };
	if (
		committedManifest.name !== options.packageName ||
		committedManifest.version !== options.releaseVersion
	) {
		throw new Error("release inputs do not match committed public package metadata");
	}

	await mkdir(options.evidenceDirectory, { recursive: true });
	const evidencePath = join(
		options.evidenceDirectory,
		`npm-provenance-${releaseCommit}.json`,
	);
	await rm(evidencePath, { force: true });

	const registryUrl = options.registryUrl.replace(/\/$/, "");
	const metadataUrl = `${registryUrl}/${encodeURIComponent(options.packageName)}/${encodeURIComponent(options.releaseVersion)}`;
	const metadataResponse = await fetch(metadataUrl, {
		headers: { Accept: "application/vnd.npm.install-v1+json" },
	});
	if (!metadataResponse.ok) {
		throw new Error(
			`published package metadata request failed with ${metadataResponse.status}`,
		);
	}
	const metadata = (await metadataResponse.json()) as PublishedMetadata;
	if (
		metadata.name !== options.packageName ||
		metadata.version !== options.releaseVersion
	) {
		throw new Error("published package registry name/version mismatch");
	}
	const gitHead = requireString(metadata.gitHead, "gitHead").toLowerCase();
	if (gitHead !== releaseCommit) {
		throw new Error(
			`published package gitHead ${gitHead} does not match release commit ${releaseCommit}`,
		);
	}
	const integrity = requireString(metadata.dist?.integrity, "dist.integrity");
	const shasum = requireString(metadata.dist?.shasum, "dist.shasum").toLowerCase();
	const tarballUrl = requireString(metadata.dist?.tarball, "dist.tarball");

	const tarballResponse = await fetch(tarballUrl);
	if (!tarballResponse.ok) {
		throw new Error(
			`published package tarball request failed with ${tarballResponse.status}`,
		);
	}
	const bytes = new Uint8Array(await tarballResponse.arrayBuffer());
	const actualShasum = createHash("sha1").update(bytes).digest("hex");
	if (actualShasum !== shasum) {
		throw new Error("published package dist.shasum does not match the tarball");
	}
	const sha512Integrity = verifyIntegrity(bytes, integrity);

	const temporaryDirectory = await mkdtemp(join(tmpdir(), "docsmint-published-"));
	try {
		const tarballPath = join(temporaryDirectory, "package.tgz");
		await Bun.write(tarballPath, bytes);
		const listed = (await commandOutput(["tar", "-tzf", tarballPath]))
			.split("\n")
			.map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
			.filter(Boolean)
			.sort();
		if (
			listed.some(
				(entry) =>
					(entry !== "package" && !entry.startsWith("package/")) ||
					entry.split("/").some((segment) => segment === ".."),
			)
		) {
			throw new Error("published package tarball contains an unsafe path");
		}
		const verbose = await commandOutput(["tar", "-tvzf", tarballPath]);
		if (verbose.split("\n").some((line) => /^[lh]/.test(line))) {
			throw new Error("published package tarball contains a link entry");
		}
		for (const expected of requiredPackageFiles) {
			if (!listed.includes(expected)) {
				throw new Error(`published package is missing required file ${expected}`);
			}
		}

		const extracted = join(temporaryDirectory, "extracted");
		await mkdir(extracted);
		await commandOutput(["tar", "-xzf", tarballPath, "-C", extracted]);
		const manifest = (await Bun.file(
			join(extracted, "package", "package.json"),
		).json()) as Record<string, unknown>;
		if (manifest.name !== options.packageName) {
			throw new Error("published package manifest name does not match");
		}
		if (manifest.version !== options.releaseVersion) {
			throw new Error("published package manifest version does not match");
		}
		const engines = manifest.engines as Record<string, unknown> | undefined;
		if (
			typeof engines?.bun !== "string" ||
			!engines.bun.includes("1.3.14") ||
			Object.hasOwn(engines, "node")
		) {
			throw new Error("published package must declare the Bun 1.3.14+ runtime");
		}
		const advertisedTargets = new Set<string>();
		collectAdvertisedTargets(manifest.main, advertisedTargets);
		collectAdvertisedTargets(manifest.types, advertisedTargets);
		collectAdvertisedTargets(manifest.exports, advertisedTargets);
		collectAdvertisedTargets(manifest.bin, advertisedTargets);
		if (advertisedTargets.size === 0) {
			throw new Error("published package has no advertised runtime/declaration targets");
		}
		for (const target of advertisedTargets) {
			if (!listed.includes(target)) {
				throw new Error(
					`published package is missing advertised package target ${target}`,
				);
			}
		}

		await (options.runCleanConsumer ?? defaultCleanConsumer)(tarballPath);
		const evidence: PublishedPackageEvidence = {
			cleanConsumer: "passed",
			distIntegrity: integrity,
			distShasum: shasum,
			files: listed,
			gitHead,
			packageName: options.packageName,
			registryUrl,
			releaseCommit,
			releaseTag: options.releaseTag,
			releaseVersion: options.releaseVersion,
			schemaVersion: 1,
			tarballSha1: actualShasum,
			tarballSha512Integrity: sha512Integrity,
			tarballUrl,
			verifiedAt: new Date().toISOString(),
		};
		await Bun.write(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
		return evidence;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		const releaseTag = Bun.env.RELEASE_TAG?.trim() ?? "";
		const releaseVersion = Bun.env.RELEASE_VERSION?.trim() ?? "";
		const releaseCommit = Bun.env.RELEASE_COMMIT?.trim() ?? "";
		await verifyPublishedPackage({
			evidenceDirectory:
				Bun.env.RELEASE_NPM_EVIDENCE_DIRECTORY?.trim() ||
				join(root, "build", "release-evidence", "npm-provenance"),
			packageName: "@hiai-gg/docsmint",
			registryUrl:
				Bun.env.NPM_REGISTRY_URL?.trim() || "https://registry.npmjs.org",
			releaseCommit,
			releaseTag,
			releaseVersion,
		});
		console.log(
			`Published package provenance verified for ${releaseTag} at ${releaseCommit}`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
