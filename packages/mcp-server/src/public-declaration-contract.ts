import type {
	CreateDocsmintMcpServerOptions as DeclaredOptions,
	HiaiDocsClient as DeclaredClient,
} from "../../sdk/templates/mcp-server.js";
import type { HiaiDocsClient as SourceClient } from "./client.js";
import type { CreateDocsmintMcpServerOptions as SourceOptions } from "./server.js";

type Extends<Left, Right> = [Left] extends [Right] ? true : false;
type Assert<Condition extends true> = Condition;

type DeclaredClientAcceptsSource = Assert<
	Extends<SourceClient, DeclaredClient>
>;
type SourceClientAcceptsDeclaration = Assert<
	Extends<DeclaredClient, SourceClient>
>;
type DeclaredOptionsAcceptSource = Assert<
	Extends<SourceOptions, DeclaredOptions>
>;
type SourceOptionsAcceptDeclaration = Assert<
	Extends<DeclaredOptions, SourceOptions>
>;

type SourceModule = typeof import("./server.js");
type DeclaredModule = typeof import("../../sdk/templates/mcp-server.js");
type DeclaredFactoryAcceptsSource = Assert<
	Extends<SourceModule["createDocsmintMcpServer"], DeclaredModule["createDocsmintMcpServer"]>
>;
type SourceFactoryAcceptsDeclaration = Assert<
	Extends<DeclaredModule["createDocsmintMcpServer"], SourceModule["createDocsmintMcpServer"]>
>;
type DeclaredRegistrationAcceptsSource = Assert<
	Extends<
		SourceModule["registerDocsmintMcpCapabilities"],
		DeclaredModule["registerDocsmintMcpCapabilities"]
	>
>;
type SourceRegistrationAcceptsDeclaration = Assert<
	Extends<
		DeclaredModule["registerDocsmintMcpCapabilities"],
		SourceModule["registerDocsmintMcpCapabilities"]
	>
>;

export type PublicMcpDeclarationContract =
	| DeclaredClientAcceptsSource
	| SourceClientAcceptsDeclaration
	| DeclaredOptionsAcceptSource
	| SourceOptionsAcceptDeclaration
	| DeclaredFactoryAcceptsSource
	| SourceFactoryAcceptsDeclaration
	| DeclaredRegistrationAcceptsSource
	| SourceRegistrationAcceptsDeclaration;
