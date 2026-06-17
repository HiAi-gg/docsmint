<script lang="ts">
import "../app.css";
import { getLocale } from "$lib/paraglide/runtime";
import { initTheme, subscribeTheme, themeStore } from "$lib/stores/theme.svelte";

const { children } = $props();

initTheme();

$effect(() => {
	const _ = themeStore.value;
	return subscribeTheme(() => {
		if (typeof document === "undefined") return;
		document.documentElement.classList.toggle("dark", themeStore.isDark);
	});
});
</script>

<svelte:head>
	<meta name="description" content="Self-hosted AI-first documentation platform" />
	<meta name="og:type" content="website" />
	<meta name="og:title" content="hiai-docs" />
	<meta name="og:description" content="AI-first documentation platform with semantic search" />
</svelte:head>

{@render children()}
