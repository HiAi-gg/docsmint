/** Public-web ingress for the self-hosted MCP endpoint. No session or operator authority is added. */
export async function proxyMcpRequest(
	request: Request,
	options: { apiBaseUrl: string; fetch: typeof globalThis.fetch },
): Promise<Response> {
	const incoming = new URL(request.url);
	const target = new URL("mcp", `${options.apiBaseUrl.replace(/\/+$/, "")}/`);
	target.search = incoming.search;
	const headers = new Headers(request.headers);
	stripHopByHop(headers);
	for (const name of [
		"host",
		"content-length",
		"cookie",
		"x-api-key",
		"x-docsmint-workspace-context",
	])
		headers.delete(name);
	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers,
		redirect: "manual",
		signal: request.signal,
	};
	if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
		init.body = request.body;
		init.duplex = "half";
	}
	try {
		const response = await options.fetch(target, init);
		const responseHeaders = new Headers(response.headers);
		stripHopByHop(responseHeaders);
		responseHeaders.delete("set-cookie");
		// Fetch exposes decoded bodies; upstream compression/framing lengths no longer apply.
		responseHeaders.delete("content-encoding");
		responseHeaders.delete("content-length");
		responseHeaders.set("cache-control", "no-store");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	} catch {
		return Response.json(
			{ error: "MCP proxy unavailable" },
			{ status: 502, headers: { "cache-control": "no-store" } },
		);
	}
}
function stripHopByHop(headers: Headers): void {
	const connectionHeaders =
		headers
			.get("connection")
			?.split(",")
			.map((name) => name.trim())
			.filter(Boolean) ?? [];
	for (const name of [
		...connectionHeaders,
		"connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
	])
		headers.delete(name);
}
