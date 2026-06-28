import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: [vitePreprocess()],
  kit: {
    adapter: adapter(),
    csrf: {
      checkOrigin: false,
    },
    alias: {
      "$lib/*": "src/lib/*",
    },
  },
};

export default config;
