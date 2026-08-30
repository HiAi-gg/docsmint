import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const appId = env.PUBLIC_APP_ID ?? env.VITE_APP_ID ?? "hiai-docs";
	const deploymentId =
		env.PUBLIC_DEPLOYMENT_ID ?? env.VITE_DEPLOYMENT_ID ?? "docsmint-oss-0.7.7";

	return {
  plugins: [
    tailwindcss(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      strategy: ["url", "cookie", "baseLocale"],
    }),
    sveltekit(),
    // VitePWA owns both compilation and injection of the custom worker. Using
    // the framework-neutral plugin avoids @vite-pwa/sveltekit's dependency on
    // SvelteKit's reserved `service-worker.js` intermediate artifact.
    VitePWA({
      registerType: "prompt", // A4: user controls updates (no mid-edit SW takeover)
      // Registration is performed in hooks.client.ts. Keeping it explicit
      // avoids SvelteKit and vite-plugin-pwa registering different filenames.
      injectRegister: false,
      strategies: "injectManifest", // A1: custom service worker
      srcDir: "src/pwa",
      filename: "sw.ts",
      manifest: {
        name: "DocsMint",
        short_name: "DocsMint",
        description: "Self-hosted AI-native knowledge workspace",
        theme_color: "#0f172a",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "any",
        categories: ["productivity", "documentation"],
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/maskable-icon.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      // For the `injectManifest` strategy the precache glob is read from
      // `injectManifest` (not `workbox`).
      injectManifest: {
        globPatterns: ["**/*.{html,js,css,ico,png,svg,webp,woff2}"],
        // SvelteKit does not emit a prerendered directory for this
        // authenticated app. Ignore the adapter default explicitly so the
        // production PWA build stays warning-free.
		// vite-plugin-pwa adds the generated manifest explicitly. Excluding it
		// from the Workbox glob prevents two entries with different revisions,
		// which makes the worker throw during script evaluation and disables PWA.
        globIgnores: [
          "client/manifest.webmanifest",
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 50701,
    host: true,
    // strictPort: vite's default silently picks the next free port,
    // which would leave http://localhost:50701 serving the stale
    // build (held by a previous container) while the new server
    // runs on 5173. Fail loudly instead.
    strictPort: true,
  },
	define: {
		"import.meta.env.VITE_APP_ID": JSON.stringify(appId),
		"import.meta.env.VITE_DEPLOYMENT_ID": JSON.stringify(deploymentId),
		"import.meta.env.PUBLIC_APP_ID": JSON.stringify(appId),
		"import.meta.env.PUBLIC_DEPLOYMENT_ID": JSON.stringify(deploymentId),
	},
	};
});
