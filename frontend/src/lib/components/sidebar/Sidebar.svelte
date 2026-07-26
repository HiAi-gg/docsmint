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
import { onMount } from "svelte";
import { page } from "$app/state";
import SearchBar from "$lib/components/SearchBar.svelte";
import SettingsDialog from "$lib/components/SettingsDialog.svelte";
import FolderTree from "$lib/components/sidebar/FolderTree.svelte";
import RecentDocs from "$lib/components/sidebar/RecentDocs.svelte";
import TagList from "$lib/components/sidebar/TagList.svelte";
import { getFrontendExtensions } from "$lib/extensions/context";
import { resolveExtensions } from "$lib/extensions/resolve";
import {
	getDocsmintRouteAdapter,
	navigateDocsmintRoute,
	resolveDocsmintRoute,
} from "$lib/hosts/route-context";
import * as m from "$lib/paraglide/messages.js";
import { refreshFolders } from "$lib/stores/subfolders-refresh-store.svelte.js";
import { refreshDocs } from "$lib/stores/tag-store.svelte.js";
import { cn } from "$lib/utils";

let {
	mobile = false,
	mobileOpen = false,
	element = $bindable(null),
}: {
	mobile?: boolean;
	mobileOpen?: boolean;
	element?: HTMLElement | null;
} = $props();

const SIDEBAR_COLLAPSED_KEY = "hiai_sidebar_collapsed";
const route = getDocsmintRouteAdapter();
let collapsed = $state(false);
let showSettings = $state(false);
type PanelMode = "all" | "recent" | "tags";
let activePanel = $state<PanelMode>("all");
const isCollapsed = $derived(!mobile && collapsed);

let width = $state(256); // default is 256px
let isResizing = $state(false);

const frontendExtensions = getFrontendExtensions();
const sidebarTopExtensions = $derived(
	resolveExtensions(frontendExtensions.sidebarTop, {
		pathname: page.url.pathname,
	}),
);
const navigationExtensions = $derived(
	resolveExtensions(frontendExtensions.navigation, {
		pathname: page.url.pathname,
	}),
);

onMount(() => {
	const refreshWorkspaceViews = () => {
		refreshFolders();
		refreshDocs();
	};
	window.addEventListener("hiai-docs:documents-updated", refreshWorkspaceViews);
	return () =>
		window.removeEventListener(
			"hiai-docs:documents-updated",
			refreshWorkspaceViews,
		);
});

$effect(() => {
	if (typeof window !== "undefined") {
		try {
			collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
		} catch {
			// Ignore storage failures (for example private browsing restrictions).
		}
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
	return navigateDocsmintRoute(route, "/search");
}

function togglePanel(mode: PanelMode) {
	activePanel = activePanel === mode ? "all" : mode;
	collapsed = false;
	persistCollapsed();
}

function toggleCollapse() {
	collapsed = !collapsed;
	persistCollapsed();
	if (collapsed) {
		activePanel = "all";
	}
}

function persistCollapsed() {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
	} catch {
		// Ignore storage failures; the sidebar remains usable for this session.
	}
}
</script>

<aside
  bind:this={element}
  id={mobile ? "mobile-navigation" : undefined}
  role={mobile && mobileOpen ? "dialog" : undefined}
  aria-modal={mobile && mobileOpen ? "true" : undefined}
  aria-label={mobile ? "Navigation" : undefined}
  aria-hidden={mobile && !mobileOpen ? "true" : undefined}
  tabindex="-1"
  inert={mobile && !mobileOpen}
  class={cn(
	"flex flex-col border-r border-border bg-card",
	mobile && "fixed inset-y-0 left-0 z-50 h-full w-[80%] max-w-[320px] shadow-xl transition-transform duration-300 ease-out",
	mobile && (mobileOpen ? "translate-x-0" : "-translate-x-full"),
	!mobile && "relative h-screen",
    !mobile && !isResizing && "transition-[width] duration-200"
  )}
  style={mobile
	? "padding-top: env(safe-area-inset-top);"
    : isCollapsed
      ? "width: 48px;"
      : `width: ${width}px;`}
>
  <!-- Resize Handle (desktop only — disabled inside the mobile sheet) -->
  {#if !mobile && !isCollapsed}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      role="separator"
      tabindex="-1"
      class={cn(
		"absolute right-0 top-0 z-40 h-full w-1 cursor-col-resize hover:bg-primary/50 transition-colors",
        isResizing && "bg-primary w-1"
      )}
      onmousedown={startResize}
    ></div>
  {/if}
  <!-- Toggle (desktop only — the collapse affordance is irrelevant in the sheet) -->
  {#if !mobile}
    <button
      onclick={toggleCollapse}
      class="sidebar-collapse-toggle absolute -right-3 top-4 z-40 flex size-6 items-center justify-center rounded-full border border-border bg-background shadow-sm hover:bg-accent"
    >
      {#if isCollapsed}
        <PanelLeftOpen class="size-3.5" />
      {:else}
        <PanelLeftClose class="size-3.5" />
      {/if}
    </button>
  {/if}

  {#if !isCollapsed}
    <div class="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
	  {#each sidebarTopExtensions as extension (extension.id)}
		{@const SidebarTop = extension.component}
		<SidebarTop collapsed={false} />
	  {/each}
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

      {#if activePanel === "all" && navigationExtensions.length > 0}
        <div class="h-px bg-border"></div>
        <nav class="space-y-1" aria-label="Product navigation">
          {#each navigationExtensions as extension (extension.id)}
            {@const Icon = extension.icon}
            <a
              href={extension.href ? resolveDocsmintRoute(route, extension.href) : "#"}
              aria-disabled={extension.disabled}
              class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              {#if Icon}<Icon class="size-4" />{/if}
              <span class="min-w-0 flex-1 truncate">{extension.label}</span>
              {#if extension.badge !== undefined}
                <span class="rounded bg-muted px-1.5 py-0.5 text-xs">{extension.badge}</span>
              {/if}
            </a>
          {/each}
        </nav>
      {/if}
    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center gap-1 pt-14">
	  {#each sidebarTopExtensions as extension (extension.id)}
		{@const SidebarTop = extension.component}
		<SidebarTop collapsed={true} />
	  {/each}
      <button
        onclick={() => navigateDocsmintRoute(route, "/")}
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
      {#each navigationExtensions as extension (extension.id)}
        {@const Icon = extension.icon}
        <a
          href={extension.href ? resolveDocsmintRoute(route, extension.href) : "#"}
          aria-disabled={extension.disabled}
          class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50"
          title={extension.label}
          aria-label={extension.label}
        >
          {#if Icon}<Icon class="size-4" />{:else}<span class="text-xs">{extension.label.slice(0, 1)}</span>{/if}
        </a>
      {/each}
    </div>
  {/if}

  <div class="border-t border-border p-2">
    {#if isCollapsed}
      <div class="flex flex-col items-center gap-2">
        <button
          type="button"
          onclick={() => { showSettings = true; }}
          class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title={m.settings_title()}
          aria-label={m.settings_title()}
        >
          <SettingsIcon class="size-4" />
        </button>
        <a
          href="https://docsmint.com"
          target="_blank"
          rel="noopener noreferrer"
          class="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={m.sidebar_powered_by()}
          aria-label={m.sidebar_powered_by()}
        >
          <img src="/favicon.ico" alt="DocsMint" class="size-5 object-contain dark:hidden" />
          <img src="/favicon_white.ico" alt="" aria-hidden="true" class="hidden size-5 object-contain dark:block" />
        </a>
      </div>
    {:else}
      <div class="flex items-center justify-between">
        <a
          href="https://docsmint.com"
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs text-muted-foreground hover:text-foreground transition-colors"
          title={m.sidebar_powered_by()}
        >
          {m.sidebar_powered_by()}
        </a>
        <button
          type="button"
          onclick={() => { showSettings = true; }}
          class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title={m.settings_title()}
          aria-label={m.settings_title()}
        >
          <SettingsIcon class="size-4" />
        </button>
      </div>
    {/if}
  </div>
</aside>

<SettingsDialog bind:open={showSettings} />
