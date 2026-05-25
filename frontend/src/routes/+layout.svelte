<script lang="ts">
  import "../app.css";
  import { ParaglideJS } from "@inlang/paraglide-sveltekit";
  import { i18n } from "$lib/i18n";
  import { languageTag } from "$lib/paraglide/runtime.js";

  let { children } = $props();
</script>

<svelte:head>
  <html lang={languageTag()}></html>
  <meta name="description" content="Self-hosted AI-first documentation platform" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="hiai-docs" />
  <meta property="og:description" content="AI-first documentation platform with semantic search" />
</svelte:head>

<ParaglideJS {i18n}>
  {@render children()}
</ParaglideJS>
