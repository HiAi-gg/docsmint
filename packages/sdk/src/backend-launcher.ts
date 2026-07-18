/** Server-only launcher for the bundled DocsMint backend runtime. */

export type DocsmintBackendEnvironment = Readonly<
	Record<string, string | undefined>
>;

export type LaunchDocsmintBackendOptions = Readonly<{
	cwd?: string;
	env?: DocsmintBackendEnvironment;
	healthUrl?: string;
	startupTimeoutMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
}>;

export type DocsmintBackendProcess = Readonly<{
	pid: number;
	exited: Promise<number>;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}>;

export type DocsmintBackendSpawnSpec = Readonly<{
	command: readonly string[];
	cwd?: string;
	env: Readonly<Record<string, string>>;
}>;

export type DocsmintBackendLauncherRuntime = Readonly<{
	executable: string;
	launcherModuleUrl?: string | URL;
	spawn(spec: DocsmintBackendSpawnSpec): DocsmintBackendProcess;
	fetch(input: string, init?: RequestInit): Promise<Response>;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
}>;

export type DocsmintBackendHandle = Readonly<{
	pid: number;
	ready: Promise<void>;
	exited: Promise<number>;
	stop(): Promise<void>;
}>;

export type DocsmintBackendLauncher = Readonly<{
	launch(options?: LaunchDocsmintBackendOptions): DocsmintBackendHandle;
}>;

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_API_PORT = "50700";

function assertPositiveMilliseconds(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
}

function immutableEnvironment(
	overrides: DocsmintBackendEnvironment = {},
): Readonly<Record<string, string>> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
		if (typeof value === "string") merged[key] = value;
	}
	return Object.freeze(merged);
}

export function resolveDocsmintBackendEntrypoint(
	launcherModuleUrl: string | URL = import.meta.url,
): URL {
	return new URL("./backend/index.js", launcherModuleUrl);
}

function defaultRuntime(): DocsmintBackendLauncherRuntime {
	if (typeof Bun === "undefined") {
		throw new Error("DocsMint backend launcher requires the Bun runtime");
	}
	return {
		executable: Bun.argv[0] ?? "bun",
		spawn(spec) {
			const child = Bun.spawn({
				cmd: [...spec.command],
				...(spec.cwd ? { cwd: spec.cwd } : {}),
				env: { ...spec.env },
				stdout: "inherit",
				stderr: "inherit",
			});
			return {
				pid: child.pid,
				exited: child.exited,
				kill(signal) {
					child.kill(signal);
				},
			};
		},
		fetch: (input, init) => fetch(input, init),
		now: Date.now,
		sleep: (milliseconds) => Bun.sleep(milliseconds),
	};
}

export function createDocsmintBackendLauncher(
	runtime: DocsmintBackendLauncherRuntime,
): DocsmintBackendLauncher {
	const now = runtime.now ?? Date.now;
	const sleep = runtime.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));

	return Object.freeze({
		launch(
			options: LaunchDocsmintBackendOptions = {},
		): DocsmintBackendHandle {
			const startupTimeoutMs =
				options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
			const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
			assertPositiveMilliseconds(startupTimeoutMs, "startupTimeoutMs");
			assertPositiveMilliseconds(pollIntervalMs, "pollIntervalMs");
			if (options.signal?.aborted) {
				throw new DOMException("Backend launch aborted", "AbortError");
			}

			const env = immutableEnvironment(options.env);
			const port = env.API_PORT ?? DEFAULT_API_PORT;
			const healthUrl = options.healthUrl ?? `http://127.0.0.1:${port}/api/health`;
			const entrypoint = resolveDocsmintBackendEntrypoint(
				runtime.launcherModuleUrl ?? import.meta.url,
			);
			const child = runtime.spawn(
				Object.freeze({
					command: Object.freeze([runtime.executable, entrypoint.pathname]),
					...(options.cwd ? { cwd: options.cwd } : {}),
					env,
				}),
			);
			let stopped = false;
			const stop = async (): Promise<void> => {
				if (stopped) return;
				stopped = true;
				child.kill("SIGTERM");
			};

			const ready = (async (): Promise<void> => {
				const deadline = now() + startupTimeoutMs;
				try {
					while (now() <= deadline) {
						if (options.signal?.aborted) {
							throw new DOMException("Backend launch aborted", "AbortError");
						}
						try {
							const response = await runtime.fetch(healthUrl, {
								signal: options.signal,
							});
							if (response.ok) return;
						} catch (error) {
							if (options.signal?.aborted) throw error;
						}
						await sleep(pollIntervalMs);
					}
					throw new Error(
						`DocsMint backend did not become ready within ${startupTimeoutMs}ms`,
					);
				} catch (error) {
					await stop();
					throw error;
				}
			})();

			return Object.freeze({
				pid: child.pid,
				ready,
				exited: child.exited,
				stop,
			});
		},
	});
}

export function launchDocsmintBackend(
	options: LaunchDocsmintBackendOptions = {},
): DocsmintBackendHandle {
	return createDocsmintBackendLauncher(defaultRuntime()).launch(options);
}
