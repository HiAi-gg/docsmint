import { proxyMcpRequest } from "#lib/server/mcp-proxy.js";
import type { RequestHandler } from "./$types";

// Let the backend normalize /mcp/ internally; never redirect a credentialed POST.
export const trailingSlash = "ignore";
const API_BASE = process.env.API_URL || "http://localhost:50700";
// event.fetch injects the frontend Origin on unsafe cross-origin requests.
// MCP server clients may intentionally omit Origin; forward their headers unchanged.
const proxy: RequestHandler = ({ request }) =>
	proxyMcpRequest(request, { apiBaseUrl: API_BASE, fetch: globalThis.fetch });
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
