type JsonObject = Record<string, unknown>;

function asObject(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as JsonObject;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}
	return value;
}

export async function validateMcpCatalog(root = new URL("../", import.meta.url)): Promise<void> {
	const registry = asObject(await Bun.file(new URL("server.json", root)).json(), "server.json");
	const glama = asObject(await Bun.file(new URL("glama.json", root)).json(), "glama.json");
	const published = asObject(
		await Bun.file(new URL("package.public.json", root)).json(),
		"package.public.json",
	);

	if (registry.$schema !== "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json") {
		throw new Error("server.json must use the 2025-12-11 MCP registry schema");
	}
	if (registry.name !== "io.github.HiAi-gg/docsmint") {
		throw new Error("server.json name must be io.github.HiAi-gg/docsmint");
	}
	if (registry.websiteUrl !== "https://docsmint.com/docs/mcp") {
		throw new Error("server.json websiteUrl must be the hosted MCP docs");
	}
	if (asString(published.license, "package.public.json license") !== "Apache-2.0") {
		throw new Error("public package license must be Apache-2.0");
	}

	const meta = asObject(
		asObject(registry._meta, "server.json _meta")[
			"io.modelcontextprotocol.registry/publisher-provided"
		],
		"publisher-provided metadata",
	);
	if (meta.license !== "Apache-2.0") {
		throw new Error("server.json must declare Apache-2.0");
	}
	if (meta.licenseUrl !== "https://www.apache.org/licenses/LICENSE-2.0") {
		throw new Error("server.json licenseUrl must be the Apache-2.0 SPDX URL");
	}
	if (meta.documentationUrl !== "https://docsmint.com/docs/mcp") {
		throw new Error("server.json documentationUrl must be the hosted MCP docs");
	}

	const remotes = asArray(registry.remotes, "server.json remotes");
	const remote = asObject(remotes[0], "server.json remotes[0]");
	if (remote.type !== "streamable-http" || remote.url !== "https://docsmint.com/mcp") {
		throw new Error("hosted MCP remote must stay https://docsmint.com/mcp");
	}

	const packages = asArray(registry.packages, "server.json packages");
	const npmPackage = asObject(packages[0], "server.json packages[0]");
	if (npmPackage.runtimeHint !== "npx") {
		throw new Error("stdio package must hint npx");
	}
	const packageArguments = asArray(npmPackage.packageArguments, "packageArguments");
	const firstArgument = asObject(packageArguments[0], "packageArguments[0]");
	if (firstArgument.type !== "positional" || firstArgument.value !== "docsmint-mcp") {
		throw new Error("stdio package must invoke the docsmint-mcp binary");
	}

	if (glama.$schema !== "https://glama.ai/mcp/schemas/connector.json") {
		throw new Error("glama.json must use the Glama connector schema");
	}
	const maintainers = asArray(glama.maintainers, "glama.json maintainers");
	const emails = maintainers.map((entry) => asString(asObject(entry, "maintainer").email, "maintainer email"));
	if (!emails.includes("app.croco.team@gmail.com")) {
		throw new Error("glama.json must list the public maintainer contact");
	}
	if (emails.some((email) => email === "vlgalib" || email.endsWith("@users.noreply.github.com"))) {
		throw new Error("glama.json must not list a personal GitHub username");
	}
}

if (import.meta.main) {
	try {
		await validateMcpCatalog();
		console.log("MCP catalog manifests are valid");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
