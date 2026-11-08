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

async function readBrowserJson(session: string, expression: string): Promise<unknown> {
	return jsonResult(await browserJson(session, ["eval", expression]));
}

async function waitForBrowserCondition(session: string, expression: string, label: string) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await readBrowserJson(session, `JSON.stringify(Boolean(${expression}))`)) return;
		await Bun.sleep(150);
	}
	throw new Error(`Timed out waiting for browser condition: ${label}`);
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

async function verifyLegacyMarkdownRestore(
	session: string,
	documentPage: string,
): Promise<void> {
	const create = await readBrowserJson(session, `(async () => {
		const headers = { "content-type": "application/json" };
		const markdown = label => label + "\\n\\n" + "Legacy Markdown sentence. ".repeat(10_000);
		const created = await fetch("/api/documents", {
			method: "POST", headers,
			body: JSON.stringify({ title: "Synthetic legacy Markdown history", content: markdown("Legacy alpha") }),
		});
		if (!created.ok) throw new Error("Legacy document creation failed: " + created.status);
		const { id } = await created.json();
		const edited = await fetch("/api/documents/" + id, {
			method: "PATCH", headers, body: JSON.stringify({ content: markdown("Legacy bravo") }),
		});
		if (!edited.ok) throw new Error("Legacy document update failed: " + edited.status);
		return JSON.stringify({ id });
	})()`) as { id: string };
	const path = "/api/documents/" + create.id;
	const pageUrl = new URL(documentPage);
	pageUrl.pathname = pageUrl.pathname.replace(/[^/]+$/, create.id);
	const checkState = () => readBrowserJson(session, `(async () => {
		const doc = await (await fetch(${JSON.stringify(path)})).json();
		const versions = await (await fetch(${JSON.stringify(path + "/versions")})).json();
		return JSON.stringify({
			text: doc.content?.split("\\n", 1)[0],
			hasJson: doc.contentJson != null,
			count: versions.length,
		});
	})()`) as Promise<{ text: string; hasJson: boolean; count: number }>;

	await browser(session, ["open", pageUrl.toString()]);
	const rendered = `document.querySelector('[aria-label="Document content editor"]')?.textContent`;
	await waitForBrowserCondition(session, `${rendered}?.startsWith("Legacy bravo")`, "legacy current Markdown");
	const before = await checkState();
	if (before.hasJson || before.text !== "Legacy bravo") throw new Error("Expected legacy Markdown only");
	await browser(session, ["find", "role", "button", "click", "--name", "Version History"]);
	const prior = `Array.from(document.querySelectorAll('.version-panel button')).find(button => button.textContent.trim().startsWith('Legacy alpha'))`;
	await waitForBrowserCondition(session, prior, "legacy history item");
	await readBrowserJson(session, `JSON.stringify((${prior}).click() ?? true)`);
	await waitForBrowserCondition(session, `${rendered}?.startsWith("Legacy alpha")`, "legacy version preview");
	await browser(session, ["find", "role", "radio", "click", "--name", "Markdown mode"]);
	await waitForBrowserCondition(
		session,
		`document.querySelector('[aria-label="Historical Markdown"]')?.textContent?.startsWith("Legacy alpha")`,
		"legacy Markdown preview",
	);
	await browser(session, ["find", "role", "radio", "click", "--name", "WYSIWYG mode"]);
	await readBrowserJson(session, `JSON.stringify((${prior}).parentElement.querySelector('[aria-label="Restore this version"]').click() ?? true)`);
	const confirm = "Array.from(document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')).find(button => button.textContent.trim() === 'Restore')";
	await waitForBrowserCondition(session, confirm, "legacy restore confirmation");
	await readBrowserJson(session, `JSON.stringify((${confirm}).click() ?? true)`);
	await waitForBrowserCondition(session, `!document.querySelector('.version-panel') && ${rendered}?.startsWith("Legacy alpha")`, "legacy version restored");
	// Wait beyond the editor debounce so a render-triggered write cannot escape detection.
	await browser(session, ["wait", "3000"]);
	const restored = await checkState();
	if (restored.text !== "Legacy alpha" || restored.hasJson || restored.count !== before.count + 2) {
		throw new Error("Legacy preview or restore caused an extra write: " + JSON.stringify({ before, restored }));
	}
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

		const nextContent = `${content} second revision`;
		await readBrowserJson(session,
			`JSON.stringify((() => {
				const editor = document.querySelector('[aria-label="Document content editor"]');
				if (!(editor instanceof HTMLElement)) throw new Error('Document editor missing');
				editor.focus();
				editor.innerHTML = '<p></p>';
				editor.querySelector('p').textContent = ${JSON.stringify(nextContent)};
				editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(nextContent)} }));
				globalThis.__docsmintVersionReleaseProbe = true;
				return true;
			})())`
		);
		const documentUrl = `${baseUrl}/api/documents/${apiProof.id}`;
		const readDocumentBody = async () => readBrowserJson(session,
			`(async () => JSON.stringify((await (await fetch(${JSON.stringify(documentUrl)})).json()).content))()`
		);
		const saveDeadline = Date.now() + 15_000;
		while ((await readDocumentBody()) !== nextContent) {
			if (Date.now() >= saveDeadline) throw new Error("Second browser edit did not persist");
			await Bun.sleep(150);
		}

		if (mode === "mobile") {
			await browser(session, ["find", "role", "button", "click", "--name", "More options"]);
		}
		await browser(session, [
			"find", "role", mode === "mobile" ? "menuitem" : "button", "click",
			"--name", "Version History",
		]);
		const priorButton = `Array.from(document.querySelectorAll('.version-panel button')).find(button => button.textContent.trim() === ${JSON.stringify(content)})`;
		await waitForBrowserCondition(session, priorButton, "prior history item");
		await readBrowserJson(session, `JSON.stringify((${priorButton}).click() ?? true)`);
		const contentSelector = '[aria-label="Document content editor"]';
		const editorText = `document.querySelector(${JSON.stringify(contentSelector)})?.textContent?.trim()`;
		await waitForBrowserCondition(session, `${editorText} === ${JSON.stringify(content)}`, "version preview");
		if ((await readDocumentBody()) !== nextContent) throw new Error("Version preview changed the live document");
		await browser(session, ["find", "role", "button", "click", "--name", "Return to current"]);
		await waitForBrowserCondition(session, `${editorText} === ${JSON.stringify(nextContent)}`, "return to current");

		await readBrowserJson(session, `JSON.stringify((() => {
			const restore = (${priorButton}).parentElement.querySelector('[aria-label="Restore this version"]');
			if (!restore) throw new Error('Version restore action missing');
			restore.click();
			return true;
		})())`);
		const confirm = "Array.from(document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')).find(button => button.textContent.trim() === 'Restore')";
		await waitForBrowserCondition(session, confirm, "restore confirmation");
		await readBrowserJson(session, `JSON.stringify((${confirm}).click() ?? true)`);
		await waitForBrowserCondition(session, `${editorText} === ${JSON.stringify(content)}`, "restored editor");
		if ((await readDocumentBody()) !== content) throw new Error("Restore did not update the live document");
		if (!(await readBrowserJson(session, "JSON.stringify(globalThis.__docsmintVersionReleaseProbe === true)"))) {
			throw new Error("Version flow reloaded the document page");
		}

		const capabilities = jsonResult(
			await browserJson(session, [
				"eval",
				'JSON.stringify({ serviceWorkerSupported: "serviceWorker" in navigator, cacheStorageSupported: "caches" in globalThis, controlled: Boolean(navigator.serviceWorker?.controller) })',
			]),
		);
		await browser(session, ["screenshot", screenshot]);
		const documentPage = await browser(session, ["get", "url"]);
		if (mode === "desktop") await verifyLegacyMarkdownRestore(session, documentPage);
		const diagnostics = await browserDiagnostics(session);
		return {
			mode,
			session,
			url: documentPage,
			title,
			content,
			apiProof,
			versionHistory: { preview: true, restored: true, stayedInPage: true },
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
