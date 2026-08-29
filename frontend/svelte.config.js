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
    // SvelteKit 2 defaults `paths.relative` to true, which emits
    // `./_app/immutable/...` from nested routes (`/login`, `/docs/:id`).
    // Those resolve to `/login/_app/...` and 404, so the whole UI renders
    // unstyled. The PWA worker and Caddy cache `/_app/immutable/*` from
    // the origin root.
    paths: {
      relative: false,
    },
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
