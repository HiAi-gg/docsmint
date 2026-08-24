import { fileURLToPath } from "node:url";

export type RepositoryFile = Readonly<{ path: string; source: string }>;
export type SecretFinding = Readonly<{ path: string; detector: string }>;
export type TrackedGitEntry = Readonly<{ path: string; mode: string; oid: string }>;

const patternDetectors = [
	{
		name: "private key",
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
	},
	{ name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
	{
		name: "GitHub token",
		pattern:
			/\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
	},
	{ name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
	{ name: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
	{ name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
	{ name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
	{ name: "Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
	{ name: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
] as const;

const repositoryAuthSecretNames = [
	"BETTER_AUTH_SECRET",
	"CSRF_SECRET",
	"WEBHOOK_SECRET",
	"STORAGE_SECRET_KEY",
	"HIAI_DOCS_API_KEY",
	"DOCSMINT_WORKSPACE_SECRET",
	"API_KEY_ENCRYPTION_SECRET",
	"OPENROUTER_API_KEY",
	"EMBEDDING_API_KEY",
	"GRAPH_EXTRACT_API_KEY",
] as const;
const authAssignmentPattern = new RegExp(
	`^\\s*(?:(?:export\\s+)?(?:const|let|var)\\s+)?(?:${repositoryAuthSecretNames.join("|")})\\s*([:=])\\s*(.+?)\\s*[,;]?\\s*$`,
	"gim",
);
const postgresUrlPattern =
	/\bpostgres(?:ql)?:\/\/([^\s/"'`]+)@[^\s"'`]+/gi;

function normalizedValue(value: string): string {
	return value
		.replace(/\s+#.*$/, "")
		.replace(/^[`'"]+|[`'",;]+$/g, "")
		.trim();
}

function isFixturePath(path: string): boolean {
	return (
		path.startsWith(".github/workflows/") ||
		/(?:^|\/)(?:tests?|fixtures?)(?:\/|\.|$)/i.test(path) ||
		/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
		/(?:^|\/)scripts\/(?:test-|rehearse-|check-)/.test(path)
	);
}

function isDocumentationOrExamplePath(path: string): boolean {
	return (
		path === ".env.example" ||
		/\.example$/i.test(path) ||
		path === "README.md" ||
		path.startsWith("docs/") ||
		path.startsWith(".github/ISSUE_TEMPLATE/")
	);
}

function isDocumentedPlaceholder(value: string): boolean {
	const normalized = normalizedValue(value);
	return (
		normalized.length === 0 ||
		/^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/i.test(normalized) ||
		/^\$\{[A-Z0-9_]+(?::[-?][^}]*)?\}$/i.test(normalized) ||
		/^<[^>]+>$/.test(normalized) ||
		/^\[[^\]]+\]$/.test(normalized) ||
		/\.\.\./.test(normalized) ||
		/(?:^|[-_ .])(?:placeholder|redacted|not-a-real|fake|dummy)(?:$|[-_ .])/i.test(
			normalized,
		) ||
		/^(?:your[-_ ].+|change[-_ ]?me|replace[-_ ]?me|placeholder(?:[-_ ].*)?|example(?:[-_ ].*)?|password|secret)$/i.test(
			normalized,
		)
	);
}

function isNonLiteralAssignment(
	path: string,
	delimiter: string,
	value: string,
): boolean {
	const trimmed = value.trim().replace(/[,;]\s*$/, "");
	if (/^["'].*["']$/s.test(trimmed)) return false;
	if (/^`.*`$/s.test(trimmed)) return trimmed.includes("${");
	return (
		(/\.[cm]?[jt]sx?$/i.test(path) &&
			delimiter === ":" &&
			/^[A-Za-z_$][\w$]*$/.test(trimmed)) ||
		(/\.[cm]?[jt]sx?$/i.test(path) &&
			/^[a-z_$][\w$]*[A-Z][\w$]*$/.test(trimmed)) ||
		/^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?:\([^)]*\))?$/.test(
			trimmed,
		) ||
		/\.(?:repeat|min|max|optional|default|transform|refine)\s*\(/.test(
			trimmed,
		) ||
		/(?:=>|\?\?|\|\||&&|\bnew\s+|\bfunction\b)/.test(trimmed)
	);
}

function isClearlySyntheticValue(path: string, value: string): boolean {
	const normalized = normalizedValue(value);
	const humanReadable = /[-_ ]/.test(normalized);
	if (isFixturePath(path)) {
		return normalized.length < 20 || humanReadable;
	}
	if (isDocumentationOrExamplePath(path)) {
		return normalized.length < 20 || humanReadable;
	}
	return false;
}

function isScopedFixtureValue(path: string, value: string): boolean {
	if (!isFixturePath(path)) return false;
	return /^(?:test(?:[-_]|password|key|secret)|ci[-_]|compose-contract[-_]|task4[-_]|rehearsal[-_]|fixture[-_]|dummy[-_]|not-a-real[-_]|dev[-_]|local[-_]|mock[-_]|fake[-_]|insecure[-_]|valid[-_])/i.test(
		normalizedValue(value),
	);
}

function hasCredentialBearingPostgresUrl(file: RepositoryFile): boolean {
	postgresUrlPattern.lastIndex = 0;
	for (const match of file.source.matchAll(postgresUrlPattern)) {
		const authority = match[1] ?? "";
		if (/\$\{[^}]+\}/.test(authority)) continue;
		const separator = authority.lastIndexOf(":");
		if (separator < 0) continue;
		const password = authority.slice(separator + 1);
		if (
			!isDocumentedPlaceholder(password) &&
			!isScopedFixtureValue(file.path, password) &&
			!isClearlySyntheticValue(file.path, password)
		) {
			return true;
		}
	}
	return false;
}

function hasRepositoryAuthSecret(file: RepositoryFile): boolean {
	authAssignmentPattern.lastIndex = 0;
	for (const match of file.source.matchAll(authAssignmentPattern)) {
		const delimiter = match[1] ?? "";
		const value = match[2] ?? "";
		if (
			!isNonLiteralAssignment(file.path, delimiter, value) &&
			!isDocumentedPlaceholder(value) &&
			!isScopedFixtureValue(file.path, value) &&
			!isClearlySyntheticValue(file.path, value)
		) {
			return true;
		}
	}
	return false;
}

export function findSecretCandidates(
	files: readonly RepositoryFile[],
): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const file of files) {
		for (const detector of patternDetectors) {
			detector.pattern.lastIndex = 0;
			if (
				[...file.source.matchAll(detector.pattern)].some(
					(match) => !isDocumentedPlaceholder(match[0] ?? ""),
				)
			) {
				findings.push({ path: file.path, detector: detector.name });
			}
		}
		if (hasCredentialBearingPostgresUrl(file)) {
			findings.push({
				path: file.path,
				detector: "credential-bearing PostgreSQL URL",
			});
		}
		if (hasRepositoryAuthSecret(file)) {
			findings.push({ path: file.path, detector: "repository auth secret" });
		}
	}
	return findings;
}

function parseTrackedGitEntries(listing: string): TrackedGitEntry[] {
	return listing
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const match = /^(\d{6}) ([0-9a-f]{40,64}) \d+\t([\s\S]+)$/.exec(record);
			if (!match) throw new Error("Unable to parse tracked Git index entry");
			return {
				mode: match[1] ?? "",
				oid: match[2] ?? "",
				path: match[3] ?? "",
			};
		});
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args[0] ?? "command"} failed with exit ${exitCode}`);
	}
	return stdout;
}

async function trackedGitEntries(root: string): Promise<TrackedGitEntry[]> {
	return parseTrackedGitEntries(
		await runGit(root, ["ls-files", "--stage", "-z"]),
	);
}

export async function loadTrackedGitBlobs(
	entries: readonly TrackedGitEntry[],
	readBlob: (oid: string) => Promise<string>,
): Promise<RepositoryFile[]> {
	const files: RepositoryFile[] = [];
	for (const entry of entries) {
		if (entry.mode === "160000") continue;
		try {
			files.push({ path: entry.path, source: await readBlob(entry.oid) });
		} catch {
			throw new Error(`Unable to read tracked Git blob: ${entry.path}`);
		}
	}
	return files;
}

async function repositoryFiles(root: string): Promise<RepositoryFile[]> {
	const entries = await trackedGitEntries(root);
	return loadTrackedGitBlobs(entries, (oid) =>
		runGit(root, ["cat-file", "blob", oid]),
	);
}

export async function scanTrackedRepository(
	root: string,
): Promise<SecretFinding[]> {
	return findSecretCandidates(await repositoryFiles(root));
}

if (import.meta.main) {
	const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
	try {
		const files = await repositoryFiles(root);
		const findings = findSecretCandidates(files);
		if (findings.length > 0) {
			for (const finding of findings) {
				console.error(
					`Potential secret detected: ${finding.path} (${finding.detector})`,
				);
			}
			process.exitCode = 1;
		} else {
			console.log(
				`Secret scan passed: ${files.length} tracked Git blobs checked`,
			);
		}
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "Secret scan failed closed",
		);
		process.exitCode = 1;
	}
}
