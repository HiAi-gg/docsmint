#!/usr/bin/env bun
/** DocsMint MCP stdio entry point. */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createDocsmintMcpServer } from './server.js';

serveStdio(() => createDocsmintMcpServer());
