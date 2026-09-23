import { expect, test } from "bun:test";
import { Elysia } from "elysia";

import { selfHostedApiRoutes } from "../api/register-routes";

test("self-hosted API does not expose the DocsMint Cloud MCP authorization routes", async () => {
	const app = new Elysia().use(selfHostedApiRoutes);
	expect(
		app.routes.some(
			(route) => route.method === "GET" && route.path === "/api/documents",
		),
	).toBe(true);
	const hostedAuthorizationRoutes = [
		["GET", "/.well-known/oauth-protected-resource"],
		["GET", "/.well-known/oauth-protected-resource/mcp"],
		["GET", "/.well-known/oauth-authorization-server"],
		["POST", "/oauth/register"],
		["GET", "/oauth/authorize"],
		["POST", "/oauth/token"],
	] as const;

	for (const [method, path] of hostedAuthorizationRoutes) {
		const response = await app.handle(
			new Request(`http://localhost${path}`, { method }),
		);
		expect(response.status, `${method} ${path}`).toBe(404);
	}
});
