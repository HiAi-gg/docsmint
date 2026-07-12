#!/usr/bin/env bun
/**
 * `hiai-docs` — terminal CLI for the hiai-docs knowledge base.
 *
 * Built on commander. Each command is a self-contained module under
 * `./commands/`; this file is just the registration table.
 *
 * Bun-native. ESM-only. No external color/formatting libraries.
 */

import { Command } from "commander";
import { configFilePath, loadConfig, saveConfig } from "./config.js";
import { client, type HiaiDocsClient } from "./client.js";
import { registerConfig } from "./commands/config.js";
import { registerCreate } from "./commands/create.js";
import { registerDelete } from "./commands/delete.js";
import { registerExport } from "./commands/export.js";
import { registerFolders } from "./commands/folders.js";
import { registerHistory } from "./commands/history.js";
import { registerList } from "./commands/list.js";
import { registerRead } from "./commands/read.js";
import { registerRestore } from "./commands/restore.js";
import { registerSearch } from "./commands/search.js";
import { registerSnapshot } from "./commands/snapshot.js";
import { registerUpdate } from "./commands/update.js";

const VERSION = "0.2.8";

const program = new Command();
program
	.name("hiai-docs")
	.description("CLI for the hiai-docs knowledge base")
	.version(VERSION);

const getClient = (): HiaiDocsClient => client;

// Bootstrap command — interactive first-run helper.
program
	.command("init")
	.description("Initialize the CLI (writes ~/.hiai-docs/config.json)")
	.option("--url <url>", "API base URL")
	.option("--key <key>", "API key")
	.action(async (opts: { url?: string; key?: string }) => {
		const current = loadConfig();
		const next = {
			url: opts.url ?? current.url,
			apiKey: opts.key ?? current.apiKey,
		};
		saveConfig(next);
		process.stdout.write(`Config written to ${configFilePath()}\n`);
		process.stdout.write(`url:  ${next.url}\n`);
		if (next.apiKey) {
			process.stdout.write(`key:  ${next.apiKey.slice(0, 4)}…(redacted)\n`);
		} else {
			process.stdout.write("key:  (unset)\n");
		}
	});

// Register the spec'd commands.
registerSearch(program, getClient);
registerList(program, getClient);
registerRead(program, getClient);
registerCreate(program, getClient);
registerUpdate(program, getClient);
registerDelete(program, getClient);
registerSnapshot(program, getClient);
registerHistory(program, getClient);
registerRestore(program, getClient);
registerExport(program, getClient);
registerFolders(program, getClient);
registerConfig(program);

await program.parseAsync(process.argv);
