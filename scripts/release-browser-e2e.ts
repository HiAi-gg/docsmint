import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

type JsonCommandResult = Readonly<{
	success: boolean;
	data?: Record<string, unknown>;
	error?: unknown;
}>;

const root = resolve(import.meta.dir, "..");
const baseUrl = (Bun.env.RELEASE_BROWSER_BASE_URL ?? "http://127.0.0.1:50701").replace(
	/\/$/,
	"",
);
const evidenceDirectory = resolve(
	root,
	Bun.env.RELEASE_EVIDENCE_DIRECTORY ?? "build/release-evidence",
);
const engine = Bun.env.AGENT_BROWSER_ENGINE;
const runId = (Bun.env.RELEASE_EVIDENCE_RUN_ID ?? Bun.env.GITHUB_RUN_ID ?? `${Date.now()}`)
	.replace(/[^a-zA-Z0-9-]/g, "")
	.slice(-12);
if (engine !== "lightpanda") {
	throw new Error("Release browser E2E requires AGENT_BROWSER_ENGINE=lightpanda");
}

async function command(
	program: string,
	args: readonly string[],
	expectSuccess = true,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const process = Bun.spawn([program, ...args], {
		cwd: root,
		env: {
			...Bun.env,
			AGENT_BROWSER_ENGINE: "lightpanda",
			LIGHTPANDA_DISABLE_TELEMETRY: "true",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (expectSuccess && exitCode !== 0) {
		throw new Error(
			`${program} ${args.join(" ")} failed with exit ${exitCode}: ${stderr || stdout}`,
		);
	}
	return { stdout, stderr, exitCode };
}

async function gitHead(): Promise<string> {
	return (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
}

async function browser(
	session: string,
	args: readonly string[],
): Promise<string> {
	return (await command("agent-browser", ["--session", session, ...args])).stdout.trim();
}

async function browserJson(
	session: string,
	args: readonly string[],
): Promise<JsonCommandResult> {
	const output = await browser(session, ["--json", ...args]);
	const parsed = JSON.parse(output) as JsonCommandResult;
	if (!parsed.success) {
		throw new Error(`agent-browser JSON command failed: ${JSON.stringify(parsed.error)}`);
	}
	return parsed;
}

async function waitForUrl(
	session: string,
	predicate: (url: string) => boolean,
	description: string,
): Promise<string> {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		const url = await browser(session, ["get", "url"]);
		if (predicate(url)) return url;
		await Bun.sleep(250);
	}
	throw new Error(`Timed out waiting for browser URL: ${description}`);
}

function jsonResult(result: JsonCommandResult): unknown {
	const serialized = result.data?.result;
	if (typeof serialized !== "string") {
		throw new Error("agent-browser eval did not return a serialized result");
	}
	return JSON.parse(serialized);
}

async function browserDiagnostics(
	session: string,
): Promise<{ errors: number; consoleErrors: number }> {
	const errorsResult = await browserJson(session, ["errors"]);
	const consoleResult = await browserJson(session, ["console"]);
	const errors = Array.isArray(errorsResult.data?.errors)
		? errorsResult.data.errors.length
		: -1;
	const messages = Array.isArray(consoleResult.data?.messages)
		? (consoleResult.data.messages as Array<Record<string, unknown>>)
		: [];
	const consoleErrors = messages.filter((message) => message.type === "error").length;
	if (errors !== 0 || consoleErrors !== 0) {
		throw new Error(
			`Browser diagnostics are not clean: errors=${errors}, consoleErrors=${consoleErrors}`,
		);
	}
	return { errors, consoleErrors };
}

async function runFlow(
	mode: "desktop" | "mobile",
	commit: string,
): Promise<Record<string, unknown>> {
	const shortCommit = commit.slice(0, 12);
	const session = `release-${mode}-${shortCommit}-${runId}`;
	const title = `Release ${shortCommit} ${mode} document`;
	const content = `DocsMint ${shortCommit} ${mode} release browser content`;
	const email = `release-${mode}-${shortCommit}-${runId}@example.test`;
	const screenshot = join(evidenceDirectory, `${mode}.png`);

	try {
		await browser(session, ["open", `${baseUrl}/register`]);
		await browser(session, [
			"set",
			"headers",
			JSON.stringify({
				Origin: baseUrl,
				"X-Forwarded-For": mode === "desktop" ? "127.0.0.77" : "127.0.0.78",
			}),
		]);
		if (mode === "mobile") {
			await browser(session, ["set", "device", "iPhone 14"]);
		} else {
			await browser(session, ["set", "viewport", "1440", "900"]);
		}
		await browser(session, ["find", "label", "Name", "fill", `Release ${mode}`]);
		await browser(session, ["find", "label", "Email", "fill", email]);
		await browser(session, [
			"find",
			"label",
			"Password",
			"fill",
			"release-browser-password-32-chars",
		]);
		await browser(session, [
			"find",
			"role",
			"button",
			"click",
			"--name",
			"Create account",
		]);
		await waitForUrl(session, (url) => url === `${baseUrl}/`, "dashboard");

		if (mode === "mobile") {
			await browser(session, [
				"find",
				"role",
				"button",
				"click",
				"--name",
				"Open navigation menu",
			]);
			await browser(session, [
				"find",
				"role",
				"button",
				"click",
				"--name",
				"Close navigation menu",
			]);
		}

		await browser(session, [
			"find",
			"role",
			"button",
			"click",
			"--name",
			"New Document",
		]);
		await waitForUrl(
			session,
			(url) => url.startsWith(`${baseUrl}/docs/`),
			"created document",
		);
		await browserJson(session, [
			"eval",
			`JSON.stringify((() => { const element = document.querySelector('[aria-label="Document title"]'); if (!(element instanceof HTMLInputElement)) throw new Error('Document title input is missing'); element.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(element, ${JSON.stringify(title)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.blur(); return { value: element.value }; })())`,
		]);
		await browserJson(session, [
			"eval",
			`JSON.stringify((() => { const editor = document.querySelector('[aria-label="Document content editor"]'); if (!(editor instanceof HTMLElement)) throw new Error('Document content editor is missing'); editor.focus(); editor.innerHTML = '<p></p>'; const paragraph = editor.querySelector('p'); if (!paragraph) throw new Error('Document editor paragraph is missing'); paragraph.textContent = ${JSON.stringify(content)}; editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(content)} })); return { text: editor.textContent }; })())`,
		]);
		await browser(session, ["wait", "5000"]);

		const apiProof = jsonResult(
			await browserJson(session, [
				"eval",
				"(async () => { const id = location.pathname.split('/').at(-1); const response = await fetch(`/api/documents/${id}`); return JSON.stringify({ id, status: response.status, body: await response.json() }); })()",
			]),
		) as Record<string, unknown>;
		const serializedProof = JSON.stringify(apiProof);
		if (
			apiProof.status !== 200 ||
			!serializedProof.includes(title) ||
			!serializedProof.includes(content)
		) {
			throw new Error("Browser flow did not persist the exact document title and content");
		}

		const capabilities = jsonResult(
			await browserJson(session, [
				"eval",
				'JSON.stringify({ serviceWorkerSupported: "serviceWorker" in navigator, cacheStorageSupported: "caches" in globalThis, controlled: Boolean(navigator.serviceWorker?.controller) })',
			]),
		);
		await browser(session, ["screenshot", screenshot]);
		const diagnostics = await browserDiagnostics(session);
		return {
			mode,
			session,
			url: await browser(session, ["get", "url"]),
			title,
			content,
			apiProof,
			capabilities,
			diagnostics,
			screenshot,
		};
	} finally {
		await command(
			"agent-browser",
			["--session", session, "close"],
			false,
		);
	}
}

const commit = await gitHead();
const expectedCommit = Bun.env.RELEASE_COMMIT ?? commit;
if (commit !== expectedCommit) {
	throw new Error(`Release browser commit mismatch: expected ${expectedCommit}, got ${commit}`);
}

const agentBrowserVersion = (await command("agent-browser", ["--version"])).stdout.trim();
const lightpandaVersion = (await command("lightpanda", ["version"])).stdout.trim();
const [manifestResponse, serviceWorkerResponse] = await Promise.all([
	fetch(`${baseUrl}/manifest.webmanifest`),
	fetch(`${baseUrl}/sw.js`),
]);
const manifest = (await manifestResponse.json()) as {
	name?: string;
	icons?: readonly unknown[];
};
const serviceWorker = await serviceWorkerResponse.text();
if (
	manifestResponse.status !== 200 ||
	manifest.name !== "DocsMint" ||
	!Array.isArray(manifest.icons) ||
	manifest.icons.length === 0
) {
	throw new Error("Release manifest artifact is not valid DocsMint content");
}
if (
	serviceWorkerResponse.status !== 200 ||
	!serviceWorker.includes("self.addEventListener")
) {
	throw new Error("Release service worker artifact is not valid JavaScript content");
}

await mkdir(evidenceDirectory, { recursive: true });
const desktop = await runFlow("desktop", commit);
const mobile = await runFlow("mobile", commit);
const evidence = {
	schemaVersion: 1,
	commit,
	engine: "lightpanda",
	agentBrowserVersion,
	lightpandaVersion,
	baseUrl,
	runId,
	artifacts: {
		manifest: { status: manifestResponse.status, name: manifest.name, icons: manifest.icons.length },
		serviceWorker: { status: serviceWorkerResponse.status, bytes: serviceWorker.length },
	},
	desktop,
	mobile,
	offlineControllerLimitation:
		"Lightpanda does not implement ServiceWorker or CacheStorage; artifacts are HTTP-validated and no Chrome fallback is permitted.",
};
await Bun.write(
	join(evidenceDirectory, "browser-e2e.json"),
	`${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(
	`Release browser E2E passed for ${commit}: desktop/mobile, manifest 200, service worker 200, console/errors 0`,
);
