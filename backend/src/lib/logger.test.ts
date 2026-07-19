import { expect, test } from "bun:test";
import { createDocsMintLoggerOptions } from "./logger";

test("development logger falls back to JSON when pino-pretty is not installed", () => {
	const options = createDocsMintLoggerOptions(
		{ NODE_ENV: "development", LOG_LEVEL: "debug" },
		() => {
			throw new Error("module not found");
		},
	);

	expect(options).toEqual({ level: "debug", transport: undefined });
});

test("development logger enables pretty transport only after resolving pino-pretty", () => {
	const requested: string[] = [];
	const options = createDocsMintLoggerOptions(
		{ NODE_ENV: "development" },
		(specifier) => {
			requested.push(specifier);
			return `file:///fixture/${specifier}.js`;
		},
	);

	expect(requested).toEqual(["pino-pretty"]);
	expect(options).toEqual({
		level: "info",
		transport: { target: "pino-pretty", options: { colorize: true } },
	});
});

test("production logger never probes or enables development pretty transport", () => {
	const options = createDocsMintLoggerOptions(
		{ NODE_ENV: "production" },
		() => {
			throw new Error("must not resolve in production");
		},
	);

	expect(options).toEqual({ level: "info", transport: undefined });
});
