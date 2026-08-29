import { describe, expect, test } from "bun:test";
import svelteConfig from "../frontend/svelte.config.js";

async function caddyfileSource(): Promise<string> {
	return Bun.file(
		new URL("../Caddyfile", import.meta.url),
	).text();
}

function reverseProxyTargets(source: string): string[] {
	return [...source.matchAll(/^\s*reverse_proxy\s+(\S+)/gm)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
}

function contentSecurityPolicies(source: string): string[] {
	return [...source.matchAll(/Content-Security-Policy\s+"([^"]+)"/g)].flatMap(
		(match) => (match[1] ? [match[1]] : []),
	);
}

describe("supported reverse-proxy deployment", () => {
	test("routes browser API requests through SvelteKit", async () => {
		const source = await caddyfileSource();
		const upstreams = reverseProxyTargets(source);
		expect(upstreams).toContain("web:50701");
		expect(upstreams).not.toContain("api:50700");
	});

	test("uses public certificate automation and permits accepted HTTPS images", async () => {
		const source = await caddyfileSource();
		const cspValues = contentSecurityPolicies(source);
		expect(cspValues.length).toBeGreaterThan(0);
		expect(cspValues.every((policy) => /img-src[^;]*https:/.test(policy))).toBe(
			true,
		);
		expect(source).not.toMatch(/\btls\s+internal\b/);
	});

	test("keeps SvelteKit origin validation enabled", () => {
		const csrf = svelteConfig.kit?.csrf as
			| { checkOrigin?: boolean; trustedOrigins?: string[] }
			| undefined;
		expect(csrf?.checkOrigin).not.toBe(false);
		expect(csrf?.trustedOrigins ?? []).not.toContain("*");
	});

	test("emits origin-root asset URLs so nested routes can load CSS", () => {
		expect(svelteConfig.kit?.paths?.relative).toBe(false);
	});
});
