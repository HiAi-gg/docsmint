import createClient from "openapi-fetch";
import type { paths } from "../../build/openapi-paths";

function openApiClient(baseUrl: string, apiKey?: string) {
	return createClient<paths>({
		baseUrl,
		headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
	});
}

export async function discoverWithOpenApi(
	baseUrl: string,
	apiKey: string,
	title: string,
) {
	const client = openApiClient(baseUrl, apiKey);
	const identity = await client.GET("/api/whoami");
	const workspaces = await client.GET("/api/workspaces");
	const suggestions = await client.GET("/api/search/suggest", {
		params: { query: { q: title } },
	});
	const rejected = await openApiClient(baseUrl).GET("/api/whoami");

	return { identity, workspaces, suggestions, rejected };
}
