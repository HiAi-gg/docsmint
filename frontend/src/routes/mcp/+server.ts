import { proxyMcpRequest } from "#lib/server/mcp-proxy.js";
import type { RequestHandler } from "./$types";

// Let the backend normalize /mcp/ internally; never redirect a credentialed POST.
export const trailingSlash = "ignore";
const API_BASE = process.env.API_URL || "http://localhost:50700";
const proxy: RequestHandler = ({ request, fetch }) =>
	proxyMcpRequest(request, { apiBaseUrl: API_BASE, fetch });
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
