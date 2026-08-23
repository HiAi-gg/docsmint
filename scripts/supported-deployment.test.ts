import { describe, expect, test } from "bun:test";
import svelteConfig from "../frontend/svelte.config.js";

type JsonObject = Record<string, unknown>;

function stripDirective(source: string, directive: string): string {
	const lines = source.split("\n");
	const output: string[] = [];
	let skipping = false;
	let depth = 0;
	for (const line of lines) {
		if (!skipping && line.trimStart().startsWith(`${directive} {`)) {
			skipping = true;
			depth = 1;
			continue;
		}
		if (skipping) {
			depth += (line.match(/\{/g) ?? []).length;
			depth -= (line.match(/\}/g) ?? []).length;
			if (depth === 0) skipping = false;
			continue;
		}
		output.push(line);
	}
	return output.join("\n");
}

function walk(value: unknown, visit: (value: JsonObject) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit);
		return;
	}
	if (!value || typeof value !== "object") return;
	visit(value as JsonObject);
	for (const child of Object.values(value as JsonObject)) walk(child, visit);
}

async function adaptCaddyfile(): Promise<JsonObject> {
	const source = stripDirective(await Bun.file("Caddyfile").text(), "rate_limit");
	const result = Bun.spawnSync({
		cmd: ["caddy", "adapt", "--config", "-", "--adapter", "caddyfile"],
		cwd: import.meta.dir.replace(/\/scripts$/, ""),
		env: { ...process.env, DOMAIN: "example.com" },
		stdin: Buffer.from(source),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString());
	}
	return JSON.parse(result.stdout.toString()) as JsonObject;
}

describe("supported reverse-proxy deployment", () => {
	test("routes browser API requests through SvelteKit", async () => {
		const config = await adaptCaddyfile();
		const upstreams: string[] = [];
		walk(config, (value) => {
			if (value.handler !== "reverse_proxy" || !Array.isArray(value.upstreams)) {
				return;
			}
			for (const upstream of value.upstreams) {
				if (upstream && typeof upstream === "object" && "dial" in upstream) {
					upstreams.push(String(upstream.dial));
				}
			}
		});
		expect(upstreams).toContain("web:50701");
		expect(upstreams).not.toContain("api:50700");
	});

	test("uses public certificate automation and permits accepted HTTPS images", async () => {
		const config = await adaptCaddyfile();
		const cspValues: string[] = [];
		const issuerModules: string[] = [];
		walk(config, (value) => {
			const response = value.response as JsonObject | undefined;
			const set = response?.set as JsonObject | undefined;
			const policies = set?.["Content-Security-Policy"];
			if (Array.isArray(policies)) cspValues.push(...policies.map(String));
			if (typeof value.module === "string") issuerModules.push(value.module);
		});
		expect(cspValues.length).toBeGreaterThan(0);
		expect(cspValues.every((policy) => /img-src[^;]*https:/.test(policy))).toBe(
			true,
		);
		expect(issuerModules).not.toContain("internal");
	});

	test("keeps SvelteKit origin validation enabled", () => {
		const csrf = svelteConfig.kit?.csrf as
			| { checkOrigin?: boolean; trustedOrigins?: string[] }
			| undefined;
		expect(csrf?.checkOrigin).not.toBe(false);
		expect(csrf?.trustedOrigins ?? []).not.toContain("*");
	});
});
