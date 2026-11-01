import { Elysia } from "elysia";
import { resolveAuthPrincipal } from "../lib/auth-principal";
import { config } from "../lib/config";
import { contentAccessForPrincipal } from "../lib/content-access";
import { integrationAllowedOrigins } from "../lib/integration-origin";
import { adminRoutes } from "./routes/admin";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { categoryRoutes } from "./routes/categories";
import { collaborationRoutes } from "./routes/collaboration";
import { documentRoutes } from "./routes/documents";
import { folderRoutes } from "./routes/folders";
import { graphRoutes } from "./routes/graph";
import {
	createIntegrationMcpServer,
	createIntegrationRoutes,
	type IntegrationApiFetch,
} from "./routes/integration";
import { keysRoutes } from "./routes/keys";
import { metricsRoutes } from "./routes/metrics";
import { pluginsRoutes } from "./routes/plugins";
import { searchRoutes } from "./routes/search";
import { shareRoutes } from "./routes/share";
import { tagRoutes } from "./routes/tags";
import { versionRoutes } from "./routes/versions";
import { visibilityRoutes } from "./routes/visibility";
import { webhookRoutes } from "./routes/webhooks";

export const selfHostedApiRoutes = new Elysia()
	.use(authRoutes)
	.use(tagRoutes)
	.use(categoryRoutes)
	.use(attachmentRoutes)
	.use(shareRoutes)
	.use(searchRoutes)
	.use(documentRoutes)
	.use(folderRoutes)
	.use(versionRoutes)
	.use(webhookRoutes)
	.use(collaborationRoutes)
	.use(graphRoutes)
	.use(keysRoutes)
	.use(pluginsRoutes)
	.use(visibilityRoutes)
	.use(adminRoutes)
	.use(metricsRoutes);

// The standalone host has one personal space per key owner. Signed Cloud
// workspace assertions are intentionally not accepted by this public gateway.
export function createSelfHostedIntegrationRoutes(
	apiFetch: IntegrationApiFetch,
) {
	return createIntegrationRoutes({
		allowedOrigins: integrationAllowedOrigins(config),
		mcpEnabled: config.MCP_HTTP_ENABLED,
		identity: async (request) => {
			const authorization = request.headers.get("authorization");
			if (!authorization?.startsWith("Bearer ") || authorization.length <= 7)
				return null;
			const headers = new Headers({ authorization });
			const principal = await resolveAuthPrincipal(headers);
			if (!principal || principal.kind === "session") return null;
			const access = contentAccessForPrincipal(principal);
			return {
				principalType: access.restricted ? "category" : "workspace",
				scopes:
					principal.kind === "api-key" ? [...principal.scopes] : ["global"],
				permissions: [...access.permissions],
				workspace: null,
				categoryId: access.categoryId,
				plan: null,
			};
		},
		apiFetch: async (request) => apiFetch(request),
		createMcpServer: async (request) =>
			createIntegrationMcpServer(request, apiFetch),
	});
}
