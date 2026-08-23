import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const hiaiUiDist = fileURLToPath(
  new URL("./node_modules/@hiai-gg/hiai-ui/dist", import.meta.url),
);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: [vitePreprocess()],
  kit: {
    adapter: adapter(),
    // The framework-neutral VitePWA plugin owns the only worker build and
    // hooks.client.ts owns the only registration at `/sw.js`.
    serviceWorker: {
      register: false,
    },
    // hiai-ui@0.0.8 exposes component directories through a wildcard export,
    // but TypeScript cannot resolve directory indexes from that map. Keep the
    // compatibility alias in SvelteKit (the canonical alias surface) rather
    // than overriding generated paths in tsconfig.json.
    alias: {
      "@hiai-gg/hiai-ui": `${hiaiUiDist}/index.js`,
      "@hiai-gg/hiai-ui/*": `${hiaiUiDist}/*`,
    },
  },
};

export default config;
