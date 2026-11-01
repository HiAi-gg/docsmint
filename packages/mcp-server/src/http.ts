import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";

export interface DocsmintMcpHttpOptions {
	/** Authenticate and create a fresh, request-scoped server; return an HTTP denial otherwise. */
	createServer(request: Request): Promise<McpServer | Response>;
	allowedOrigins: readonly string[];
	enabled?: boolean;
	onerror?: (error: Error) => void;
}

/** Stateless Streamable HTTP transport. Authentication and grants remain host-owned. */
export function createDocsmintMcpHttpHandler(options: DocsmintMcpHttpOptions): {
	fetch(request: Request): Promise<Response>;
	close(): Promise<void>;
} {
	const servers = new AsyncLocalStorage<McpServer>();
	const transport = createMcpHandler(
		async () => {
			const server = servers.getStore();
			if (!server) throw new Error("MCP request context unavailable");
			return server;
		},
		{ legacy: "stateless", responseMode: "json", onerror: options.onerror },
	);
	return {
		close: () => transport.close(),
		async fetch(request) {
			const canonical = new URL(request.url);
			if (canonical.pathname.endsWith("/mcp/")) {
				canonical.pathname = canonical.pathname.slice(0, -1);
				request = new Request(canonical, request);
			}
			const origin = request.headers.get("origin");
			const allowed = !origin || options.allowedOrigins.includes(origin);
			const cors = new Headers({ Vary: "Origin" });
			if (origin && allowed) cors.set("Access-Control-Allow-Origin", origin);
			function finish(response: Response): Response {
				const headers = new Headers(response.headers);
				headers.set(
					"Vary",
					[headers.get("Vary"), "Origin"].filter(Boolean).join(", "),
				);
				for (const [name, value] of cors)
					if (name !== "vary") headers.set(name, value);
				return new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers,
				});
			}
			if (options.enabled === false)
				return finish(new Response(null, { status: 404 }));
			if (!allowed)
				return finish(
					Response.json({ error: "Origin not allowed" }, { status: 403 }),
				);
			if (request.method === "OPTIONS") {
				cors.set("Access-Control-Allow-Methods", "POST, OPTIONS");
				cors.set(
					"Access-Control-Allow-Headers",
					"Authorization, Content-Type, MCP-Protocol-Version, X-Docsmint-Workspace",
				);
				return new Response(null, { status: 204, headers: cors });
			}
			if (request.method !== "POST")
				return finish(
					new Response(null, {
						status: 405,
						headers: { Allow: "POST, OPTIONS" },
					}),
				);
			try {
				const server = await options.createServer(request);
				if (server instanceof Response) return finish(server);
				return finish(
					await servers.run(server, () => transport.fetch(request)),
				);
			} catch (error) {
				options.onerror?.(
					error instanceof Error ? error : new Error("MCP transport failure"),
				);
				return finish(
					Response.json({ error: "MCP transport failure" }, { status: 500 }),
				);
			}
		},
	};
}
