<!-- QuickSearch.svelte — Cmd/Ctrl+K command palette. Lazy mounted by the
     root layout; renders the modal only when the shared
     `isQuickSearchOpen` flag is true so the cost is zero while closed.

     Combines:
     1. Document title suggestions via the existing
        `searchSuggest` endpoint (used by the search page autocomplete).
     2. Static commands that route to common actions (new doc, open
        search page, open settings, show keyboard shortcuts).

     Keyboard: arrows navigate, Enter selects, Esc closes (handled by
     the global dispatcher once we register an Escape shortcut). The
     palette itself does not re-implement the global handler — it just
     closes on selection or explicit click on the backdrop. -->
<script lang="ts">
import { FileText, Keyboard, Plus, Search, Settings } from "lucide-svelte";
import { type SearchSuggestion, searchSuggest } from "#lib/api/search.js";
import {
	getDocsmintRequestAdapter,
	getDocsmintRouteAdapter,
	navigateDocsmintRoute,
} from "#lib/hosts/route-context.js";
import * as m from "#lib/paraglide/messages.js";
import {
	getIsQuickSearchOpen,
	setQuickSearchOpen,
	toggleShortcutHelp,
} from "#lib/stores/keyboard.svelte.js";

interface CommandItem {
	id: string;
	label: string;
	icon: typeof Search;
	run: () => void;
}

const route = getDocsmintRouteAdapter();
const request = getDocsmintRequestAdapter();

const COMMANDS: CommandItem[] = [
	{
		id: "new-doc",
		label: m.quick_search_command_new_doc(),
		icon: Plus,
		run: () => navigateDocsmintRoute(route, "/?action=new"),
	},
	{
		id: "open-search",
		label: m.quick_search_command_open_search(),
		icon: Search,
		run: () => navigateDocsmintRoute(route, "/search"),
	},
	{
		id: "open-settings",
		label: m.quick_search_command_open_settings(),
		icon: Settings,
		run: () => navigateDocsmintRoute(route, "/settings"),
	},
	{
		id: "show-shortcuts",
		label: m.quick_search_command_show_shortcuts(),
		icon: Keyboard,
		run: () => toggleShortcutHelp(),
	},
];

let query = $state("");
let suggestions = $state<SearchSuggestion[]>([]);
let loading = $state(false);
let activeIndex = $state(0);
let inputEl = $state<HTMLInputElement | null>(null);
let listEl = $state<HTMLDivElement | null>(null);

// Combined list of selectable items: docs first, commands last.
const items = $derived.by<
	Array<
		| { kind: "doc"; suggestion: SearchSuggestion }
		| { kind: "command"; command: CommandItem }
	>
>(() => {
	const out: Array<
		| { kind: "doc"; suggestion: SearchSuggestion }
		| { kind: "command"; command: CommandItem }
	> = [];
	for (const s of suggestions) {
		out.push({ kind: "doc", suggestion: s });
	}
	// Show all commands when query is empty; otherwise only those whose
	// label matches the (case-insensitive) query.
	const q = query.trim().toLowerCase();
	for (const c of COMMANDS) {
		if (q.length === 0 || c.label.toLowerCase().includes(q)) {
			out.push({ kind: "command", command: c });
		}
	}
	return out;
});

// Keep activeIndex in bounds whenever the items list changes.
$effect(() => {
	if (activeIndex >= items.length) activeIndex = 0;
});

const isOpen = $derived(getIsQuickSearchOpen());

// Focus the input on open + reset state.
$effect(() => {
	if (isOpen) {
		query = "";
		suggestions = [];
		activeIndex = 0;
		queueMicrotask(() => inputEl?.focus());
	}
});

let suggestDebounce: ReturnType<typeof setTimeout> | null = null;
$effect(() => {
	const q = query;
	if (!isOpen) return;
	if (suggestDebounce) clearTimeout(suggestDebounce);
	suggestDebounce = setTimeout(async () => {
		const trimmed = q.trim();
		if (trimmed.length === 0) {
			suggestions = [];
			loading = false;
			return;
		}
		loading = true;
		try {
			suggestions = await searchSuggest(trimmed, request.fetch);
		} catch {
			suggestions = [];
		} finally {
			loading = false;
		}
	}, 150);
});

function close() {
	setQuickSearchOpen(false);
}

function selectAt(idx: number) {
	const item = items[idx];
	if (!item) return;
	if (item.kind === "doc") {
		navigateDocsmintRoute(route, `/docs/${item.suggestion.id}`);
	} else {
		item.command.run();
	}
	close();
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "ArrowDown") {
		e.preventDefault();
		if (items.length === 0) return;
		activeIndex = (activeIndex + 1) % items.length;
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		if (items.length === 0) return;
		activeIndex = (activeIndex - 1 + items.length) % items.length;
	} else if (e.key === "Enter") {
		e.preventDefault();
		selectAt(activeIndex);
	} else if (e.key === "Escape") {
		// Let the global Escape handler also fire; the registry is the
		// source of truth for the close shortcut. We still close here
		// for responsiveness when the global registry hasn't been
		// initialised yet.
		e.preventDefault();
		close();
	}
}
</script>

{#if isOpen}
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh]"
    onclick={close}
    onkeydown={() => {}}
    role="presentation"
  >
    <div
      class="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      onkeydown={handleKeydown}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={m.quick_search_aria()}
    >
      <div class="flex items-center gap-2 border-b border-border px-4 py-3">
        <Search class="size-4 shrink-0 text-muted-foreground" />
        <input
          bind:this={inputEl}
          type="text"
          bind:value={query}
          placeholder={m.quick_search_placeholder()}
          class="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          aria-label={m.quick_search_placeholder()}
        />
      </div>

      <div
        bind:this={listEl}
        class="max-h-[60vh] overflow-y-auto py-1"
        role="listbox"
      >
        {#if items.length === 0}
          <div class="px-4 py-8 text-center text-sm text-muted-foreground">
            {query.trim() === "" ? m.quick_search_empty() : m.quick_search_no_results()}
          </div>
        {:else}
          {#if suggestions.length > 0}
            <div class="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {m.quick_search_section_documents()}
            </div>
            {#each suggestions as suggestion, i (suggestion.id)}
              {@const idx = i}
              <button
                type="button"
                role="option"
                aria-selected={activeIndex === idx}
                onclick={() => selectAt(idx)}
                onmouseenter={() => (activeIndex = idx)}
                class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors {activeIndex === idx ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}"
              >
                <FileText class="size-4 shrink-0 text-muted-foreground" />
                <span class="min-w-0 truncate">{suggestion.title}</span>
              </button>
            {/each}
          {/if}
          {#if COMMANDS.some((c) => query.trim().length === 0 || c.label.toLowerCase().includes(query.trim().toLowerCase()))}
            <div class="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {m.quick_search_section_commands()}
            </div>
            {#each items as item, idx (item.kind === "command" ? item.command.id : `doc-${item.suggestion.id}`)}
              {#if item.kind === "command"}
                <button
                  type="button"
                  role="option"
                  aria-selected={activeIndex === idx}
                  onclick={() => selectAt(idx)}
                  onmouseenter={() => (activeIndex = idx)}
                  class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors {activeIndex === idx ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}"
                >
                  <item.command.icon class="size-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 truncate">{item.command.label}</span>
                </button>
              {/if}
            {/each}
          {/if}
        {/if}
      </div>

      <div class="border-t border-border px-4 py-1.5 text-[10px] text-muted-foreground">
        {m.quick_search_navigate_hint()}
      </div>
    </div>
  </div>
{/if}
