<script lang="ts">
import "../app.css";
import { getLocale } from "$lib/paraglide/runtime";
import { initTheme } from "$lib/stores/theme.svelte";

const { children } = $props();

initTheme();
</script>

<svelte:head>
	<meta name="description" content="Self-hosted AI-first documentation platform" />
	<meta name="og:type" content="website" />
	<meta name="og:title" content="HiAi-Docs" />
	<meta name="og:description" content="AI-first documentation platform with semantic search" />
</svelte:head>

{@render children()}
