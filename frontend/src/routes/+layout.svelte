<script lang="ts">
import "../app.css";
import { onMount } from "svelte";
import PwaInstallPrompt from "$lib/components/PwaInstallPrompt.svelte";
import PwaUpdatePrompt from "$lib/components/PwaUpdatePrompt.svelte";
import QuickSearch from "$lib/components/QuickSearch.svelte";
import ShortcutHelp from "$lib/components/ShortcutHelp.svelte";
import { networkStatus } from "$lib/offline/network-status.svelte";
import OfflineIndicator from "$lib/offline/offline-indicator.svelte";
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
	<meta name="description" content="Self-hosted AI-native knowledge workspace with hybrid search, GraphRAG, and MCP" />
	<meta property="og:type" content="website" />
	<meta property="og:title" content="DocsMint" />
	<meta property="og:description" content="Installable self-hosted knowledge workspace with offline reads and semantic search" />
	<meta name="twitter:card" content="summary" />
	{@html `
		<script type="application/ld+json">
			{
				"@context": "https://schema.org",
				"@type": "WebApplication",
				"name": "DocsMint",
				"description": "AI-native knowledge workspace with offline support",
				"applicationCategory": "ProductivityApplication",
				"operatingSystem": "Any",
				"offers": {
					"@type": "Offer",
					"price": "0",
					"priceCurrency": "USD"
				}
			}
		</script>
	`}
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

{@render children()}

<!-- Lazy-rendered command palette (`?` and Cmd/Ctrl+K). The modals
     return null when their shared open state is false, so there's no
     runtime cost while they are closed. -->
<QuickSearch />
<ShortcutHelp />
<OfflineIndicator />

<!-- PWA install banner and update notification. Both render nothing until
     their respective triggers fire, so there is no runtime cost otherwise. -->
<PwaInstallPrompt />
<PwaUpdatePrompt />
