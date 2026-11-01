import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

let phase = "configuration";
let lastHttpStatus: number | null = null;

/** Read-only release check using the official MCP client through the public web origin. */
async function main() {
	const url = new URL(
		process.env.DOCSMINT_MCP_INGRESS_URL ?? "http://127.0.0.1:50701/mcp",
	);
	const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (
		url.username ||
		url.password ||
		url.pathname !== "/mcp" ||
		url.search ||
		url.hash ||
		!(
			(local && url.protocol === "http:") ||
			url.origin === "https://docsmint.com"
		)
	) {
		throw new Error("Unexpected MCP test target");
	}
	const keyFile = process.env.DOCSMINT_MCP_TEST_KEY_FILE;
	const key = keyFile
		? (await Bun.file(keyFile).text()).trim()
		: local
			? process.env.HIAI_DOCS_API_KEY
			: undefined;
	if (!key) throw new Error("A scoped test credential is required");
	const expected = (
		await Bun.file(new URL("../package.public.json", import.meta.url)).json()
	).version as string;
	let sessionHeader = false;
	const transport = new StreamableHTTPClientTransport(url, {
		requestInit: {
			headers: { Authorization: `Bearer ${key}` },
			redirect: "error",
		},
		fetch: async (input, init) => {
			const response = await fetch(input, init);
			lastHttpStatus = response.status;
			sessionHeader ||= response.headers.has("mcp-session-id");
			return response;
		},
	});
	const client = new Client({
		name: "docsmint-release-ingress",
		version: expected,
	});
	let verified = false;
	try {
		phase = "initialize";
		await client.connect(transport);
		if (client.getServerVersion()?.version !== expected)
			throw new Error("MCP SDK version mismatch");
		phase = "tools discovery";
		const tools: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor ? { cursor } : undefined);
			tools.push(...page.tools.map((tool) => tool.name));
			cursor = page.nextCursor;
		} while (cursor);
		if (tools.length !== 22 || new Set(tools).size !== 22)
			throw new Error("MCP inventory mismatch");
		phase = "prompts discovery";
		const prompts: string[] = [];
		cursor = undefined;
		do {
			const page = await client.listPrompts(cursor ? { cursor } : undefined);
			prompts.push(...page.prompts.map((prompt) => prompt.name));
			cursor = page.nextCursor;
		} while (cursor);
		phase = "resources discovery";
		const resources: string[] = [];
		cursor = undefined;
		do {
			const page = await client.listResources(cursor ? { cursor } : undefined);
			resources.push(...page.resources.map((resource) => resource.uri));
			cursor = page.nextCursor;
		} while (cursor);
		if (prompts.length !== 2 || resources.length !== 3)
			throw new Error("MCP discovery mismatch");
		phase = "prompt retrieval";
		await client.getPrompt({
			name: "research_workspace",
			arguments: {
				question: "Synthetic release verification",
				language: "English",
			},
		});
		await client.getPrompt({
			name: "organize_workspace",
			arguments: {
				objective: "Synthetic release verification",
				language: "English",
			},
		});
		for (const uri of [
			"docsmint://guide/editor",
			"docsmint://guide/search",
			"docsmint://workspace/catalog",
		]) {
			phase = `resource read ${uri}`;
			const result = await client.readResource({ uri });
			if (!result.contents.length) throw new Error("MCP resource read failed");
		}
		if (sessionHeader)
			throw new Error("Stateless MCP unexpectedly issued a session ID");
		verified = true;
	} finally {
		if (verified) phase = "client close";
		await client.close();
	}
	phase = "verified";
	console.log(
		JSON.stringify({
			target: url.href,
			sdkVersion: expected,
			tools: 22,
			prompts: 2,
			resources: 3,
			resourceReads: 3,
			stateless: true,
			observedAt: new Date().toISOString(),
		}),
	);
}

if (import.meta.main) {
	try {
		await main();
	} catch {
		console.error(
			JSON.stringify({
				check: "HTTP MCP ingress",
				phase,
				lastHttpStatus,
				error:
					"Verification failed; credentials and response bodies are withheld.",
			}),
		);
		process.exitCode = 1;
	}
}
