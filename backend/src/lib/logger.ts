import pino from "pino";

// Read env directly to avoid circular dependency with config.ts
const level = (process.env.LOG_LEVEL ?? "info") as
	| "trace"
	| "debug"
	| "info"
	| "warn"
	| "error"
	| "fatal";
const isDev = process.env.NODE_ENV === "development";

export const logger = pino({
	level,
	transport: isDev
		? { target: "pino-pretty", options: { colorize: true } }
		: undefined,
});
