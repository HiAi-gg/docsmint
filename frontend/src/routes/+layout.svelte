<script lang="ts">
import "../app.css";
import { onMount } from "svelte";
import QuickSearch from "$lib/components/QuickSearch.svelte";
import ShortcutHelp from "$lib/components/ShortcutHelp.svelte";
import { getLocale } from "$lib/paraglide/runtime";
import {
	handleKeyEvent,
	registerDefaultShortcuts,
} from "$lib/stores/keyboard.svelte";
import { initTheme } from "$lib/stores/theme.svelte";

const { children } = $props();

initTheme();

// Register the always-on shortcuts (Cmd+K, ?, Escape) the first time the
// layout mounts. Editor and dialog-scoped shortcuts are registered by
// the components that own them, so they correctly unregister on
// teardown.
onMount(() => {
	registerDefaultShortcuts();
});

function handleGlobalKeydown(event: KeyboardEvent) {
	handleKeyEvent(event);
}
</script>

<svelte:head>
	<meta name="description" content="Self-hosted AI-first documentation platform" />
	<meta name="og:type" content="website" />
	<meta name="og:title" content="HiAi-Docs" />
	<meta name="og:description" content="AI-first documentation platform with semantic search" />
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

{@render children()}

<!-- Lazy-rendered command palette (`?` and Cmd/Ctrl+K). The modals
     return null when their shared open state is false, so there's no
     runtime cost while they are closed. -->
<QuickSearch />
<ShortcutHelp />
