<script lang="ts">
  import { PanelLeftClose, PanelLeftOpen, Folder } from "lucide-svelte";
  import { cn } from "$lib/utils";
  import SearchBar from "$lib/components/SearchBar.svelte";
  import FolderTree from "./FolderTree.svelte";
  import RecentDocs from "./RecentDocs.svelte";
  import TagList from "./TagList.svelte";
  import * as m from "$lib/paraglide/messages.js";

  let collapsed = $state(false);
</script>

<aside class={cn(
  "relative flex h-screen flex-col border-r border-border bg-card transition-[width] duration-200",
  collapsed ? "w-12" : "w-64"
)}>
  <!-- Toggle -->
  <button
    onclick={() => { collapsed = !collapsed; }}
    class="absolute -right-3 top-4 z-10 flex size-6 items-center justify-center rounded-full border border-border bg-background shadow-sm hover:bg-accent"
  >
    {#if collapsed}
      <PanelLeftOpen class="size-3.5" />
    {:else}
      <PanelLeftClose class="size-3.5" />
    {/if}
  </button>

  {#if !collapsed}
    <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
      <!-- Search -->
      <SearchBar />

      <!-- Folders -->
      <FolderTree />

      <!-- Separator -->
      <div class="h-px bg-border"></div>

      <!-- Recent Docs -->
      <RecentDocs />

      <!-- Separator -->
      <div class="h-px bg-border"></div>

      <!-- Tags -->
      <TagList />
    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center gap-3 pt-14">
      <span class="flex size-8 items-center justify-center rounded-md text-muted-foreground" title={m.sidebar_folders()}>
        <Folder class="size-4" />
      </span>
    </div>
  {/if}
</aside>
