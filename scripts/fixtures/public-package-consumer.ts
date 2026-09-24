import {
	DocsApiError,
	DocsClient,
	type DocsRequestContext,
} from "@hiai-gg/docsmint";
import {
	capabilityCatalog,
	createDocsmintMcpServer,
	registerDocsmintMcpCapabilities,
	type CreateDocsmintMcpServerOptions,
	type HiaiDocsClient,
} from "@hiai-gg/docsmint/mcp";

const context: DocsRequestContext = {
	workspaceAssertion: "signed-workspace-assertion",
};
const docsClient = new DocsClient({ baseUrl: "https://docs.example.test" });
const options: CreateDocsmintMcpServerOptions = {
	docsClient,
	requestContext: context,
};
const server = createDocsmintMcpServer(options);
const canonicalToolNames: readonly string[] = capabilityCatalog.tools;
declare const capabilityClient: HiaiDocsClient;
registerDocsmintMcpCapabilities(server, capabilityClient);
const error = new DocsApiError(
	403,
	{ error: "Forbidden", code: "workspace_forbidden" },
	"Forbidden",
	undefined,
	"workspace_forbidden",
);
void [server, error, canonicalToolNames];
