#!/usr/bin/env bun
/** DocsMint MCP stdio entry point. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createDocsmintMcpServer } from "./server.js";

const server = createDocsmintMcpServer();
await server.connect(new StdioServerTransport());
