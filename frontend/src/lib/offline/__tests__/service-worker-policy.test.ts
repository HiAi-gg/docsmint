import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

const frontendRoot = new URL("../../../../", import.meta.url);

describe("service worker offline fallback policy", () => {
	it("keeps the minimum mobile and installable PWA contract", async () => {
		const appHtml = await Bun.file(
			new URL("src/app.html", frontendRoot),
		).text();
		const config = await Bun.file(
			new URL("vite.config.ts", frontendRoot),
		).text();
		const hooks = await Bun.file(
			new URL("src/hooks.client.ts", frontendRoot),
		).text();
		const worker = await Bun.file(
			new URL("src/pwa/sw.ts", frontendRoot),
		).text();
		const compose = await Bun.file(
			new URL("../docker-compose.yml", frontendRoot),
		).text();

		expect(appHtml).toContain(
			'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		);
		expect(appHtml).toContain('<meta name="theme-color" content="#0f172a" />');
		expect(config).toContain('name: "DocsMint"');
		expect(config).toContain('display: "standalone"');
		expect(config).toContain('src: "/pwa-192x192.png"');
		expect(config).toContain('src: "/pwa-512x512.png"');
		expect(config).toContain('src: "/maskable-icon.png"');
		expect(config).toContain('"docsmint-oss-0.7.6"');
		expect(hooks).toContain('register("/sw.js", { scope: "/" })');
		expect(hooks).toContain('postMessage({ type: "SKIP_WAITING" })');
		expect(worker).toContain("void self.skipWaiting()");
		expect(worker).toContain("self.clients.claim()");
		expect(worker).toContain(
			'registerRoute(({ url }) => url.pathname.startsWith("/api/"), new NetworkOnly())',
		);
		expect(worker).toContain('url.pathname.startsWith("/api/auth/")');
		for (const icon of [
			"static/pwa-192x192.png",
			"static/pwa-512x512.png",
			"static/maskable-icon.png",
			"static/apple-touch-icon.png",
		]) {
			expect(existsSync(new URL(icon, frontendRoot)), icon).toBe(true);
		}
		expect(compose).toContain("PUBLIC_DEPLOYMENT_ID:");
		expect(compose).toContain("PUBLIC_DEPLOYMENT_ID:-docsmint-oss-0.7.6");
	});

	it("ships a data-free offline HTML shell", async () => {
		const shell = await Bun.file(
			new URL("static/offline.html", frontendRoot),
		).text();
		expect(shell).toContain("Offline — showing locally available content");
		expect(shell).not.toContain("contentJson");
		expect(shell).not.toContain("/api/");
	});

	it("uses the precached shell for failed navigations", async () => {
		const worker = await Bun.file(
			new URL("src/pwa/sw.ts", frontendRoot),
		).text();
		expect(worker).toContain('matchPrecache("/offline.html")');
		expect(worker).not.toContain('caches.match("/offline")');
	});

	it("includes the offline shell exactly once through the static asset glob", async () => {
		const config = await Bun.file(
			new URL("vite.config.ts", frontendRoot),
		).text();
		expect(config).toContain(
			'globPatterns: ["**/*.{html,js,css,ico,png,svg,webp,woff2}"]',
		);
		expect(config).not.toContain("additionalManifestEntries");
	});

	it("does not cache HTML shells after a hashed-asset deploy", async () => {
		const hooks = await Bun.file(
			new URL("src/hooks.server.ts", frontendRoot),
		).text();
		expect(hooks).toContain('Cache-Control", "no-store"');
	});

	it("does not add the generated web manifest to the precache twice", async () => {
		const config = await Bun.file(
			new URL("vite.config.ts", frontendRoot),
		).text();
		expect(config).toContain('"client/manifest.webmanifest"');
	});
});
