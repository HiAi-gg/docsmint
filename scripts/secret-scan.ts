type RepositoryFile = Readonly<{ path: string; source: string }>;
type SecretFinding = Readonly<{ path: string; detector: string }>;

const detectors = [
	{ name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
	{ name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
	{ name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
	{ name: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
	{ name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
	{ name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
	{ name: "Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
	{ name: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
] as const;

export function findSecretCandidates(files: readonly RepositoryFile[]): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const file of files) {
		if (file.source.includes("\0")) continue;
		for (const detector of detectors) {
			if (detector.pattern.test(file.source)) {
				findings.push({ path: file.path, detector: detector.name });
			}
		}
	}
	return findings;
}

async function repositoryFiles(root: string): Promise<RepositoryFile[]> {
	const git = Bun.spawn(
		["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: root, stdout: "pipe", stderr: "inherit" },
	);
	const [listed, exitCode] = await Promise.all([
		new Response(git.stdout).text(),
		git.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ls-files failed with exit ${exitCode}`);

	const files: RepositoryFile[] = [];
	for (const path of listed.split("\0").filter(Boolean)) {
		try {
			files.push({ path, source: await Bun.file(`${root}/${path}`).text() });
		} catch {
			// Gitlinks and unreadable non-regular files do not contain repository text.
		}
	}
	return files;
}

if (import.meta.main) {
	const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
	const files = await repositoryFiles(root);
	const findings = findSecretCandidates(files);
	if (findings.length > 0) {
		for (const finding of findings) {
			console.error(`Potential secret detected: ${finding.path} (${finding.detector})`);
		}
		process.exitCode = 1;
	} else {
		console.log(`Secret scan passed: ${files.length} repository files checked`);
	}
}
