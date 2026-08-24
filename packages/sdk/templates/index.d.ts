// Typecheck-only neighbor for mcp-server.d.ts. The package build copies only
// mcp-server.d.ts into dist, where this relative import resolves to dist/index.d.ts.
export * from "../src/index.js";
