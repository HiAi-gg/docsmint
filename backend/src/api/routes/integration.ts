import { DocsClient } from "@hiai-docs/sdk";
import {
	createDocsmintMcpHttpHandler,
	createDocsmintMcpServer,
} from "@hiai-docs/sdk/mcp";
import type { McpServer } from "@modelcontextprotocol/server";
import { Elysia } from "elysia";

export interface IntegrationIdentity {
	principalType: "account" | "workspace" | "category";
	scopes: string[];
	permissions: Array<"read" | "edit" | "write">;
	workspace: { id: string | null; slug: string | null } | null;
	categoryId: string | null;
	plan: null;
}
export interface IntegrationRouteOptions {
	allowedOrigins: readonly string[];
	mcpEnabled: boolean;
	/** Must authenticate Bearer only; browser sessions are not an integration principal. */
	identity(request: Request): Promise<IntegrationIdentity | null>;
	apiFetch(request: Request): Promise<Response>;
	createMcpServer(request: Request): Promise<McpServer>;
}

/** Dispatch through the complete host application, including current and future root guards. */
export type IntegrationApiFetch = (
	request: Request,
) => Response | Promise<Response>;
export async function createIntegrationMcpServer(
	request: Request,
	apiFetch: IntegrationApiFetch,
): Promise<McpServer> {
	const authorization = request.headers.get("authorization") ?? "";
	const client = new DocsClient({
		baseUrl: "http://docsmint.internal",
		apiKey: authorization.slice(7),
		retries: 1,
		fetch: (async (input: string | URL | Request, init?: RequestInit) =>
			apiFetch(new Request(input, init))) as unknown as typeof fetch,
	});
	return createDocsmintMcpServer({
		docsClient: client,
		workspaceRouting: {
			listWorkspaces: async () => [],
			assertSelection: async () => {
				throw new Error("This self-hosted space has no workspace selector");
			},
		},
	});
}

const publicCollections = new Set([
	"documents",
	"folders",
	"categories",
	"tags",
	"search",
	"graph",
	"trash",
	"attachments",
]);

export function createIntegrationRoutes(options: IntegrationRouteOptions) {
	const mcp = createDocsmintMcpHttpHandler({
		allowedOrigins: options.allowedOrigins,
		enabled: options.mcpEnabled,
		createServer: async (request) => {
			if (!(await options.identity(request))) return unauthorized();
			if (request.headers.get("X-Docsmint-Workspace"))
				return Response.json(
					{
						error: "This self-hosted space has no workspace selector",
						code: "WORKSPACE_SELECTOR_UNSUPPORTED",
					},
					{ status: 400 },
				);
			return options.createMcpServer(request);
		},
	});
	async function rest(request: Request): Promise<Response> {
		const origin = request.headers.get("Origin");
		const headers = new Headers({ Vary: "Origin" });
		const allowed = !origin || options.allowedOrigins.includes(origin);
		if (origin && allowed) headers.set("Access-Control-Allow-Origin", origin);
		const finish = (response: Response) => {
			const result = new Headers(response.headers);
			for (const [key, value] of headers) result.set(key, value);
			return new Response(response.body, {
				status: response.status,
				headers: result,
			});
		};
		if (!allowed)
			return finish(
				Response.json({ error: "Origin not allowed" }, { status: 403 }),
			);
		if (request.method === "OPTIONS") {
			headers.set(
				"Access-Control-Allow-Methods",
				"GET, POST, PUT, PATCH, DELETE, OPTIONS",
			);
			headers.set(
				"Access-Control-Allow-Headers",
				"Authorization, Content-Type, MCP-Protocol-Version, X-Docsmint-Workspace",
			);
			return new Response(null, { status: 204, headers });
		}
		const identity = await options.identity(request);
		if (!identity) return finish(unauthorized());
		if (request.headers.get("X-Docsmint-Workspace"))
			return finish(
				Response.json(
					{
						error: "This self-hosted space has no workspace selector",
						code: "WORKSPACE_SELECTOR_UNSUPPORTED",
					},
					{ status: 400 },
				),
			);
		const url = new URL(request.url);
		if (url.pathname === "/api/v1/whoami" && request.method === "GET")
			return finish(Response.json(identity));
		if (url.pathname === "/api/v1/workspaces" && request.method === "GET")
			return finish(
				Response.json([
					{
						id: null,
						name: "Personal",
						slug: null,
						entireWorkspace: identity.principalType !== "category",
						categoryIds: identity.categoryId ? [identity.categoryId] : [],
					},
				]),
			);
		const collection =
			url.pathname.slice("/api/v1/".length).split("/")[0] ?? "";
		if (!publicCollections.has(collection))
			return finish(new Response(null, { status: 404 }));
		url.pathname = url.pathname.replace(/^\/api\/v1(?=\/)/, "/api");
		const forwarded = new Headers(request.headers);
		forwarded.delete("cookie");
		forwarded.delete("x-api-key");
		forwarded.delete("x-docsmint-workspace-context");
		return finish(
			await options.apiFetch(
				new Request(url, {
					method: request.method,
					headers: forwarded,
					body:
						request.method === "GET" || request.method === "HEAD"
							? undefined
							: await request.arrayBuffer(),
				}),
			),
		);
	}
	return new Elysia()
		.onStop(async () => mcp.close())
		.all("/mcp", ({ request }) => mcp.fetch(request))
		.all("/mcp/", ({ request }) => mcp.fetch(request))
		.all("/api/v1/*", ({ request }) => rest(request));
}
function unauthorized(): Response {
	return Response.json(
		{ error: "Unauthorized" },
		{ status: 401, headers: { "WWW-Authenticate": "Bearer" } },
	);
}
