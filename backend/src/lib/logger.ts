import pino from "pino";

type LoggerEnvironment = Partial<
	Record<"LOG_LEVEL" | "NODE_ENV", string | undefined>
>;
type ModuleResolver = (specifier: string) => string;

export type DocsMintLoggerOptions = {
	level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
	transport?: { target: "pino-pretty"; options: { colorize: true } };
};

function resolvePrettyTransport(
	environment: LoggerEnvironment,
	resolveModule: ModuleResolver,
): DocsMintLoggerOptions["transport"] {
	if (environment.NODE_ENV !== "development") return undefined;

	try {
		// pino resolves the package by name itself. Probe first so a consumer of
		// the source-style public logger export never crashes merely because it
		// chose not to install the optional development formatter.
		resolveModule("pino-pretty");
		return { target: "pino-pretty", options: { colorize: true } };
	} catch {
		return undefined;
	}
}

export function createDocsMintLoggerOptions(
	environment: LoggerEnvironment = process.env,
	resolveModule: ModuleResolver = (specifier) => import.meta.resolve(specifier),
): DocsMintLoggerOptions {
	const level = (environment.LOG_LEVEL ?? "info") as
		| "trace"
		| "debug"
		| "info"
		| "warn"
		| "error"
		| "fatal";

	return {
		level,
		transport: resolvePrettyTransport(environment, resolveModule),
	};
}

export const logger = pino(createDocsMintLoggerOptions());
