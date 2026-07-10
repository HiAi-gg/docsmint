import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: [vitePreprocess()],
  kit: {
    adapter: adapter(),
    // hiai-ui@0.0.8 exposes component directories through a wildcard export,
    // but TypeScript cannot resolve directory indexes from that map. Keep the
    // compatibility alias in SvelteKit (the canonical alias surface) rather
    // than overriding generated paths in tsconfig.json.
    alias: {
      "@hiai-gg/hiai-ui": "../node_modules/@hiai-gg/hiai-ui/dist/index.js",
      "@hiai-gg/hiai-ui/*": "../node_modules/@hiai-gg/hiai-ui/dist/*",
    },
  },
};

export default config;
