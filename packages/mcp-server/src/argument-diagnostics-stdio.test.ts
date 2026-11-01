import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execPath } from "node:process";

test("the public stdio binary returns redacted JSON-RPC argument diagnostics", async () => {
	const transport = new StdioClientTransport({
		command: execPath,
		args: ["run", "packages/mcp-server/src/index.ts"],
		cwd: new URL("../../../", import.meta.url).pathname,
		env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
		stderr: "pipe",
	});
	const client = new Client({ name: "diagnostics-stdio", version: "1" });
	try {
		await client.connect(transport);
		const call = client.callTool({
			name: "save_document",
			arguments: {
				action: "secret-invalid-action",
				content: "private-not-for-errors",
			},
		});
		await expect(call).rejects.toMatchObject({
			code: -32602,
			data: { tool: "save_document", branch: null },
		});
		await call.catch((error: unknown) => {
			expect(JSON.stringify(error)).not.toContain("secret-invalid-action");
			expect(JSON.stringify(error)).not.toContain("private-not-for-errors");
		});
		expect((await client.listTools()).tools).toHaveLength(22);
	} finally {
		await client.close();
	}
});
