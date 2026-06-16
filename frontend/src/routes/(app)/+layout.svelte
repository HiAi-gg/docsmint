<script lang="ts">
import ScrollToTop from "$lib/components/ScrollToTop.svelte";
import Sidebar from "$lib/components/sidebar/Sidebar.svelte";

const { children } = $props();

let mainElement = $state<HTMLElement | null>(null);
</script>

<div class="flex h-screen">
  <Sidebar />
  <main bind:this={mainElement} class="relative z-0 flex-1 overflow-auto">
    {@render children()}
  </main>
</div>

<ScrollToTop scrollTarget={mainElement} />
