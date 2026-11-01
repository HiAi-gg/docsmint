import { expect, test } from "bun:test";
import { createDocsmintMcpServer } from "@hiai-docs/sdk/mcp";
import { Elysia } from "elysia";
import {
	createIntegrationMcpServer,
	createIntegrationRoutes,
	type IntegrationIdentity,
} from "../api/routes/integration";
import {
	integrationAllowedOrigins,
	rejectIntegrationOrigin,
} from "../lib/integration-origin";

const identity: IntegrationIdentity = {
	principalType: "category",
	scopes: ["category:synthetic:read"],
	permissions: ["read"],
	workspace: null,
	categoryId: "synthetic",
	plan: null,
};
function harness() {
	const forwarded: Request[] = [];
	let authenticated = 0;
	const routes = createIntegrationRoutes({
		allowedOrigins: ["https://allowed.invalid"],
		mcpEnabled: false,
		identity: async (request) => {
			authenticated++;
			return request.headers.get("authorization") === "Bearer scoped"
				? identity
				: null;
		},
		apiFetch: async (request) => {
			forwarded.push(request);
			return Response.json({ ok: true });
		},
		createMcpServer: async () => {
			throw new Error("disabled");
		},
	});
	return { routes, forwarded, authenticated: () => authenticated };
}
function request(
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
) {
	return new Request("http://localhost" + path, { method, headers });
}
test("identity and workspace discovery need no selection and reveal only the credential grant", async () => {
	const { routes } = harness();
	const headers = { authorization: "Bearer scoped" };
	const response = await routes.handle(request("/api/v1/whoami", headers));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(identity);
	const spaces = await routes.handle(request("/api/v1/workspaces", headers));
	expect(await spaces.json()).toEqual([
		{
			id: null,
			name: "Personal",
			slug: null,
			entireWorkspace: false,
			categoryIds: ["synthetic"],
		},
	]);
	expect(
		(
			await routes.handle(
				request("/api/v1/whoami", { cookie: "session=owner" }),
			)
		).status,
	).toBe(401);
});
test("v1 aliases only programmatic collections and strip browser/server authority", async () => {
	const { routes, forwarded } = harness();
	const response = await routes.handle(
		request("/api/v1/documents?limit=2", {
			authorization: "Bearer scoped",
			cookie: "session=owner",
			"x-api-key": "operator",
			"x-docsmint-workspace-context": "forged",
		}),
	);
	expect(response.status).toBe(200);
	expect(new URL(forwarded[0]?.url ?? "").pathname).toBe("/api/documents");
	expect(new URL(forwarded[0]?.url ?? "").search).toBe("?limit=2");
	expect(forwarded[0]?.headers.get("authorization")).toBe("Bearer scoped");
	for (const header of ["cookie", "x-api-key", "x-docsmint-workspace-context"])
		expect(forwarded[0]?.headers.get(header)).toBeNull();
	for (const path of [
		"admin",
		"auth",
		"keys",
		"plugins",
		"metrics",
		"webhooks",
	])
		expect(
			(
				await routes.handle(
					request("/api/v1/" + path, { authorization: "Bearer scoped" }),
				)
			).status,
		).toBe(404);
	expect(forwarded).toHaveLength(1);
});
test("REST Origin and CORS policy applies to denial, preflight and workspace errors", async () => {
	const { routes, authenticated } = harness();
	const foreign = await routes.handle(
		request("/api/v1/documents", {
			origin: "https://foreign.invalid",
			authorization: "Bearer scoped",
		}),
	);
	expect(foreign.status).toBe(403);
	expect(authenticated()).toBe(0);
	expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
	const denied = await routes.handle(
		request("/api/v1/whoami", { origin: "https://allowed.invalid" }),
	);
	expect(denied.status).toBe(401);
	expect(denied.headers.get("access-control-allow-origin")).toBe(
		"https://allowed.invalid",
	);
	const options = await routes.handle(
		request(
			"/api/v1/documents",
			{ origin: "https://allowed.invalid" },
			"OPTIONS",
		),
	);
	expect(options.status).toBe(204);
	expect(options.headers.get("access-control-allow-headers")).toContain(
		"Authorization",
	);
	const selection = await routes.handle(
		request("/api/v1/documents", {
			authorization: "Bearer scoped",
			"x-docsmint-workspace": "foreign",
		}),
	);
	expect(selection.status).toBe(400);
});

test("v1 writes forward exactly once with unchanged JSON and Bearer", async () => {
	const { routes, forwarded } = harness();
	const payload = JSON.stringify({ title: "Synthetic", content: "Unicode 🚀" });
	const response = await routes.handle(
		new Request("http://localhost/api/v1/documents", {
			method: "POST",
			headers: {
				authorization: "Bearer scoped",
				"content-type": "application/json",
			},
			body: payload,
		}),
	);
	expect(response.status).toBe(200);
	expect(forwarded).toHaveLength(1);
	expect(await forwarded[0]?.text()).toBe(payload);
	expect(forwarded[0]?.headers.get("authorization")).toBe("Bearer scoped");
});

test("mounted MCP routes preserve POST bodies on canonical and trailing paths", async () => {
	const requests: Request[] = [];
	const routes = createIntegrationRoutes({
		allowedOrigins: [],
		mcpEnabled: true,
		identity: async () => identity,
		apiFetch: async () => new Response(null, { status: 500 }),
		createMcpServer: async (request) => {
			requests.push(request);
			return createDocsmintMcpServer();
		},
	});
	for (const path of ["/mcp", "/mcp/"]) {
		const response = await routes.handle(
			new Request("http://localhost" + path, {
				method: "POST",
				headers: {
					authorization: "Bearer scoped",
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(await response.text()).toContain("find_documents");
	}
	expect(requests).toHaveLength(2);
	expect(
		requests.every(
			(request) => request.headers.get("authorization") === "Bearer scoped",
		),
	).toBe(true);
});

test("new Origin gate preserves legacy UI/auth requests while protecting versioned integrations", () => {
	const origins = integrationAllowedOrigins({
		BETTER_AUTH_URL: "http://localhost:50700",
	});
	for (const path of ["/api/auth/sign-in/email", "/api/documents"]) {
		expect(
			rejectIntegrationOrigin(
				new Request("http://localhost:50700" + path, {
					method: "POST",
					headers: { origin: "http://localhost:50701" },
				}),
				origins,
			),
		).toBeUndefined();
	}
	expect(
		rejectIntegrationOrigin(
			new Request("http://localhost:50700/api/v1/documents", {
				headers: { origin: "https://foreign.invalid" },
			}),
			origins,
		)?.status,
	).toBe(403);
	const configured = integrationAllowedOrigins({
		BETTER_AUTH_URL: "https://api.example.invalid",
		PUBLIC_APP_URL: "https://app.example.invalid/base",
	});
	expect(configured).toEqual([
		"https://app.example.invalid",
		"https://api.example.invalid",
	]);
	expect(
		rejectIntegrationOrigin(
			new Request("https://api.example.invalid/api/v1/documents", {
				headers: { origin: "https://app.example.invalid" },
			}),
			configured,
		),
	).toBeUndefined();
});

test("blank Compose CORS setting uses trusted public URL defaults rather than disabling them", () => {
	expect(
		integrationAllowedOrigins({
			CORS_ORIGINS: "",
			PUBLIC_APP_URL: "https://docs.example.invalid",
			BETTER_AUTH_URL: "https://api.example.invalid",
		}),
	).toEqual(["https://docs.example.invalid", "https://api.example.invalid"]);
});

test("REST aliases and MCP's SDK calls re-enter the complete root middleware chain", async () => {
	let blocked = false;
	let canonicalGuardCalls = 0;
	let legacyHandlerCalls = 0;
	const app = new Elysia()
		.onBeforeHandle(({ request }) => {
			if (new URL(request.url).pathname === "/api/categories") {
				canonicalGuardCalls++;
				if (blocked)
					return Response.json(
						{ error: "Root mutation/privacy fence denied", code: "ROOT_FENCE" },
						{ status: 403 },
					);
			}
		})
		.all("/api/categories", () => {
			legacyHandlerCalls++;
			return [];
		});
	async function dispatch(request: Request): Promise<Response> {
		return app.handle(request);
	}
	app.use(
		createIntegrationRoutes({
			allowedOrigins: [],
			mcpEnabled: true,
			identity: async () => identity,
			apiFetch: dispatch,
			createMcpServer: (request) =>
				createIntegrationMcpServer(request, dispatch),
		}),
	);
	async function callMcp(
		tool = "list_workspace_structure",
		args: Record<string, unknown> = { kind: "categories" },
	) {
		const response = await app.handle(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					authorization: "Bearer scoped",
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: tool, arguments: args },
				}),
			}),
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		const replies = response.headers
			.get("content-type")
			?.includes("text/event-stream")
			? text
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => JSON.parse(line.slice(5).trim()))
			: [JSON.parse(text)];
		return replies.find((reply) => reply.id === 1).result;
	}
	expect(
		(
			await app.handle(
				request("/api/v1/categories", { authorization: "Bearer scoped" }),
			)
		).status,
	).toBe(200);
	expect((await callMcp()).isError).not.toBe(true);
	expect(canonicalGuardCalls).toBe(2);
	expect(legacyHandlerCalls).toBe(2);
	blocked = true;
	expect(
		(
			await app.handle(
				request("/api/v1/categories", { authorization: "Bearer scoped" }),
			)
		).status,
	).toBe(403);
	const denied = await callMcp();
	expect(denied.isError).toBe(true);
	expect(JSON.parse(denied.content[0].text)).toMatchObject({
		status: 403,
		code: "ROOT_FENCE",
	});
	expect(canonicalGuardCalls).toBe(4);
	expect(legacyHandlerCalls).toBe(2);
	const write = await app.handle(
		new Request("http://localhost/api/v1/categories", {
			method: "POST",
			headers: {
				authorization: "Bearer scoped",
				"content-type": "application/json",
			},
			body: JSON.stringify({ name: "Synthetic" }),
		}),
	);
	expect(write.status).toBe(403);
	const deniedWrite = await callMcp("save_category", {
		action: "create",
		name: "Synthetic",
	});
	expect(deniedWrite.isError).toBe(true);
	expect(JSON.parse(deniedWrite.content[0].text)).toMatchObject({
		status: 403,
		code: "ROOT_FENCE",
	});
	expect(canonicalGuardCalls).toBe(6);
	expect(legacyHandlerCalls).toBe(2);
});
