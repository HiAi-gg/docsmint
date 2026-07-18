import { describe, expect, mock, test } from "bun:test";
import {
	createDocsmintBackendLauncher,
	resolveDocsmintBackendEntrypoint,
} from "./backend-launcher";

describe("DocsMint backend launcher", () => {
	test("resolves the packed backend entrypoint without checkout-relative paths", () => {
		const entrypoint = resolveDocsmintBackendEntrypoint(
			"file:///consumer/node_modules/@hiai-gg/docsmint/dist/backend-launcher.js",
		);
		expect(entrypoint.href).toBe(
			"file:///consumer/node_modules/@hiai-gg/docsmint/dist/backend/index.js",
		);
	});

	test("starts the bundled runtime with an immutable environment snapshot", async () => {
		const inputEnv = { API_PORT: "50999" };
		const kill = mock(() => undefined);
		const spawn = mock(() => ({
			pid: 42,
			exited: Promise.resolve(0),
			kill,
		}));
		const launcher = createDocsmintBackendLauncher({
			executable: "/usr/bin/bun",
			launcherModuleUrl:
				"file:///consumer/node_modules/@hiai-gg/docsmint/dist/backend-launcher.js",
			spawn,
			fetch: async () => new Response('{"status":"ok"}', { status: 200 }),
			sleep: async () => undefined,
		});

		const runtime = launcher.launch({ env: inputEnv, startupTimeoutMs: 1_000 });
		inputEnv.API_PORT = "1";
		await runtime.ready;

		expect(spawn).toHaveBeenCalledTimes(1);
		const spec = spawn.mock.calls[0]?.[0];
		expect(spec?.command[0]).toBe("/usr/bin/bun");
		expect(spec?.command[1]).toEndWith("/dist/backend/index.js");
		expect(spec?.env.API_PORT).toBe("50999");
		expect(Object.isFrozen(spec?.env)).toBe(true);
		expect(runtime.pid).toBe(42);
		await runtime.stop();
		expect(kill).toHaveBeenCalledWith("SIGTERM");
	});

	test("fails startup when health never becomes ready and stops the child", async () => {
		const kill = mock(() => undefined);
		let now = 0;
		const launcher = createDocsmintBackendLauncher({
			executable: "/usr/bin/bun",
			spawn: () => ({ pid: 7, exited: new Promise(() => undefined), kill }),
			fetch: async () => new Response(null, { status: 503 }),
			now: () => (now += 100),
			sleep: async () => undefined,
		});
		const runtime = launcher.launch({ startupTimeoutMs: 150 });
		await expect(runtime.ready).rejects.toThrow("did not become ready");
		expect(kill).toHaveBeenCalledWith("SIGTERM");
	});
});
