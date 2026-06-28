<script lang="ts">
import {
	Clock,
	Folder,
	PanelLeftClose,
	PanelLeftOpen,
	Search,
	Settings as SettingsIcon,
	Tag,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import SearchBar from "$lib/components/SearchBar.svelte";
import SettingsDialog from "$lib/components/SettingsDialog.svelte";
import FolderTree from "$lib/components/sidebar/FolderTree.svelte";
import RecentDocs from "$lib/components/sidebar/RecentDocs.svelte";
import TagList from "$lib/components/sidebar/TagList.svelte";
import * as m from "$lib/paraglide/messages.js";
import { cn } from "$lib/utils";

let collapsed = $state(false);
let showSettings = $state(false);
type PanelMode = "all" | "recent" | "tags";
let activePanel = $state<PanelMode>("all");

let width = $state(256); // default is 256px
let isResizing = $state(false);

$effect(() => {
	if (typeof window !== "undefined") {
		const saved = localStorage.getItem("hiai_sidebar_width");
		if (saved) {
			const parsed = parseInt(saved, 10);
			if (!Number.isNaN(parsed) && parsed >= 180 && parsed <= 500) {
				width = parsed;
			}
		}
	}
});

$effect(() => {
	if (isResizing) {
		window.addEventListener("mousemove", handleResize);
		window.addEventListener("mouseup", stopResize);
		return () => {
			window.removeEventListener("mousemove", handleResize);
			window.removeEventListener("mouseup", stopResize);
		};
	}
});

function startResize(e: MouseEvent) {
	e.preventDefault();
	isResizing = true;
}

function handleResize(e: MouseEvent) {
	const newWidth = Math.max(180, Math.min(500, e.clientX));
	width = newWidth;
}

function stopResize() {
	isResizing = false;
	localStorage.setItem("hiai_sidebar_width", width.toString());
}

function openSearch() {
	goto("/search");
}

function togglePanel(mode: PanelMode) {
	activePanel = activePanel === mode ? "all" : mode;
	collapsed = false;
}

function toggleCollapse() {
	collapsed = !collapsed;
	if (collapsed) {
		activePanel = "all";
	}
}
</script>

<aside
  class={cn(
    "relative flex h-screen flex-col border-r border-border bg-card",
    !isResizing && "transition-[width] duration-200"
  )}
  style={collapsed ? "width: 48px;" : `width: ${width}px;`}
>
  <!-- Resize Handle -->
  {#if !collapsed}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      role="separator"
      tabindex="-1"
      class={cn(
        "absolute right-0 top-0 z-50 h-full w-1 cursor-col-resize hover:bg-primary/50 transition-colors",
        isResizing && "bg-primary w-1"
      )}
      onmousedown={startResize}
    ></div>
  {/if}
  <!-- Toggle -->
  <button
    onclick={toggleCollapse}
    class="absolute -right-3 top-4 z-50 flex size-6 items-center justify-center rounded-full border border-border bg-background shadow-sm hover:bg-accent"
  >
    {#if collapsed}
      <PanelLeftOpen class="size-3.5" />
    {:else}
      <PanelLeftClose class="size-3.5" />
    {/if}
  </button>

  {#if !collapsed}
    <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
      <!-- Search — leave a right gap so the collapse toggle button
           (positioned at the panel's top-right edge) stays clear of it. -->
      <SearchBar class="mr-5" />

      {#if activePanel === "all"}
        <!-- Documents: FolderTree renders categories as headers, with
             folders inside each category and files inside each folder.
             The hierarchy is now: Documents → Categories → Folders → Files. -->
        <FolderTree />

        <!-- Separator -->
        <div class="h-px bg-border"></div>
      {/if}

      {#if activePanel === "all" || activePanel === "recent"}
        <!-- Recent Docs -->
        <RecentDocs />

        <!-- Separator -->
        <div class="h-px bg-border"></div>
      {/if}

      {#if activePanel === "all" || activePanel === "tags"}
        <!-- Tags -->
        <TagList />
      {/if}
    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center gap-1 pt-14">
      <button
        onclick={() => goto("/")}
        class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        title={m.sidebar_folders()}
        aria-label={m.sidebar_folders()}
      >
        <Folder class="size-4" />
      </button>
      <button
        onclick={openSearch}
        class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        title={m.search_title()}
        aria-label={m.search_title()}
      >
        <Search class="size-4" />
      </button>
      <button
        onclick={() => togglePanel("recent")}
        class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        title={m.sidebar_recent()}
        aria-label={m.sidebar_recent()}
      >
        <Clock class="size-4" />
      </button>
      <button
        onclick={() => togglePanel("tags")}
        class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        title={m.doc_tags()}
        aria-label={m.doc_tags()}
      >
        <Tag class="size-4" />
      </button>
    </div>
  {/if}

  <div class={cn("p-2", collapsed ? "flex flex-col items-center gap-2" : "space-y-2")}>
    <button
      type="button"
      onclick={() => { showSettings = true; }}
      class={cn(
        "flex items-center rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
        collapsed ? "size-8 justify-center" : "w-full gap-2 px-2 py-1.5"
      )}
      title={m.settings_title()}
      aria-label={m.settings_title()}
    >
      <SettingsIcon class="size-4 shrink-0" />
      {#if !collapsed}
        <span class="truncate">{m.settings_title()}</span>
      {/if}
    </button>
  </div>
  <div class="border-t border-border p-2">
    <a
      href="https://hiai.gg/docs"
      target="_blank"
      rel="noopener noreferrer"
      class="text-xs text-muted-foreground hover:text-foreground transition-colors"
      title={m.sidebar_powered_by()}
    >
      {#if collapsed}
        HiAi
      {:else}
        {m.sidebar_powered_by()}
      {/if}
    </a>
  </div>
</aside>

<SettingsDialog bind:open={showSettings} />
