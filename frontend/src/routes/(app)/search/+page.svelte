<script lang="ts">
import {
	Calendar,
	ChevronLeft,
	ChevronRight,
	FileSearch,
	Folder,
	Loader2,
	RotateCcw,
	Search,
	SlidersHorizontal,
	Tag,
	X,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import { getFilterOptions, type SearchResponse, search } from "$lib/api/search";
import SearchResult from "$lib/components/SearchResult.svelte";
import * as m from "$lib/paraglide/messages.js";

const { data } = $props();

// --- State -------------------------------------------------------------------
let query = $state("");
let activeFolder = $state("");
let activeTags = $state<string[]>([]);
let dateFrom = $state("");
let dateTo = $state("");
let currentPage = $state(1);
let sortOrder = $state<"relevance" | "date_desc" | "date_asc" | "name_asc" | "name_desc">(
	"relevance",
);

$effect(() => {
	query = data.query ?? "";
	activeFolder = data.filters?.folder ?? "";
	activeTags = data.filters?.tags ?? [];
	dateFrom = data.filters?.dateFrom ?? "";
	dateTo = data.filters?.dateTo ?? "";
	currentPage = data.page ?? 1;
});

let searchResponse = $state<SearchResponse | null>(null);
let loading = $state(false);
let showFilters = $state(false);

let folders = $state<string[]>([]);
let tags = $state<string[]>([]);

const PAGE_SIZE = 5;

// --- Derived -----------------------------------------------------------------
const totalPages = $derived(
	searchResponse ? Math.ceil(searchResponse.total / PAGE_SIZE) : 0,
);

const hasActiveFilters = $derived(
	activeFolder !== "" ||
		activeTags.length > 0 ||
		dateFrom !== "" ||
		dateTo !== "",
);

// --- Effects -----------------------------------------------------------------

// Load filter options on mount
$effect(() => {
	getFilterOptions().then((opts) => {
		folders = opts.folders;
		tags = opts.tags;
	});
});

// Run search when query or filters change
$effect(() => {
	const q = data.query;
	const p = data.page;
	const sort = sortOrder;
	const folder = activeFolder;
	const tags = activeTags;
	const from = dateFrom;
	const to = dateTo;

	if (!q) {
		searchResponse = null;
		loading = false;
		return;
	}

	loading = true;

	search(q, p, PAGE_SIZE, sort, {
		folder: folder || undefined,
		tags: tags.length > 0 ? tags : undefined,
		dateFrom: from || undefined,
		dateTo: to || undefined,
	}).then((res) => {
		searchResponse = res;
		loading = false;
	});
});

// --- Helpers -----------------------------------------------------------------

function buildUrl(overrides: Record<string, string | undefined>) {
	const params = new URLSearchParams();

	const q = overrides.q ?? query;
	const folder = overrides.folder ?? activeFolder;
	const t = overrides.tags ?? activeTags.join(",");
	const df = overrides.dateFrom ?? dateFrom;
	const dt = overrides.dateTo ?? dateTo;
	const p = overrides.page ?? String(currentPage);

	if (q) params.set("q", q);
	if (folder) params.set("folder", folder);
	if (t) params.set("tags", t);
	if (df) params.set("dateFrom", df);
	if (dt) params.set("dateTo", dt);
	if (p && p !== "1") params.set("page", p);

	return `/search?${params.toString()}`;
}

function handleSubmit(e: SubmitEvent) {
	e.preventDefault();
	currentPage = 1;
	goto(buildUrl({ q: query, page: "1" }), { replaceState: true });
}

function clearSearch() {
	query = "";
	activeFolder = "";
	activeTags = [];
	dateFrom = "";
	dateTo = "";
	currentPage = 1;
	goto("/search", { replaceState: true });
}

function toggleFolder(folder: string) {
	activeFolder = activeFolder === folder ? "" : folder;
	currentPage = 1;
	goto(buildUrl({ folder: activeFolder, page: "1" }), { replaceState: true });
}

function toggleTag(tag: string) {
	activeTags = activeTags.includes(tag)
		? activeTags.filter((t) => t !== tag)
		: [...activeTags, tag];
	currentPage = 1;
	goto(buildUrl({ tags: activeTags.join(","), page: "1" }), {
		replaceState: true,
	});
}

function applyDateRange() {
	currentPage = 1;
	goto(buildUrl({ dateFrom, dateTo, page: "1" }), { replaceState: true });
}

function clearFilters() {
	activeFolder = "";
	activeTags = [];
	dateFrom = "";
	dateTo = "";
	currentPage = 1;
	goto(
		buildUrl({
			folder: undefined,
			tags: undefined,
			dateFrom: undefined,
			dateTo: undefined,
			page: "1",
		}),
		{
			replaceState: true,
		},
	);
}

function goToPage(page: number) {
	currentPage = page;
	goto(buildUrl({ page: String(page) }), { replaceState: true });
}
</script>

<svelte:head>
  <title>{data.query ? m.search_title_with_query({query: data.query}) : m.search_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8">
  <!-- Search input -->
  <form onsubmit={handleSubmit} class="relative mb-6">
    <Search
      class="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
    />
    <input
      type="text"
      bind:value={query}
      placeholder={m.search_input_placeholder()}
      class="h-14 w-full rounded-xl border border-input bg-background pl-12 pr-24 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
    <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
      {#if query}
        <button
          type="button"
          onclick={clearSearch}
          class="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={m.search_clear()}
        >
          <X class="h-4 w-4" />
        </button>
      {/if}
      <button
        type="button"
        onclick={() => (showFilters = !showFilters)}
        class="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        aria-label={m.search_toggle_filters()}
      >
        <SlidersHorizontal class="h-4 w-4" />
      </button>
    </div>
  </form>

  <div class="flex gap-8">
    <!-- Filter sidebar -->
    <aside
      class="w-56 shrink-0 space-y-6"
    >
      {@render filterPanel()}
    </aside>

    <!-- Mobile filter sheet -->
    {#if showFilters}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="fixed inset-0 z-50 bg-black/50 lg:hidden"
        onclick={() => (showFilters = false)}
      >
        <div
          class="absolute right-0 top-0 h-full w-72 overflow-y-auto bg-background p-6 shadow-xl"
          onclick={(e) => e.stopPropagation()}
        >
          <div class="mb-4 flex items-center justify-between">
            <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {m.search_filters()}
            </h3>
            <button
              onclick={() => (showFilters = false)}
              class="rounded-md p-1 text-muted-foreground hover:text-foreground"
              aria-label={m.search_close_filters()}
            >
              <X class="h-4 w-4" />
            </button>
          </div>
          {@render filterPanel()}
        </div>
      </div>
    {/if}

    <!-- Results area -->
    <main class="min-w-0 flex-1">
      {#if loading}
        {@render loadingState()}
      {:else if searchResponse && searchResponse.items.length > 0}
        {@render resultsList()}
      {:else if data.query}
        {@render noResults()}
      {:else}
        {@render emptyState()}
      {/if}
    </main>
  </div>
</div>

<!-- Filter panel content (reused for sidebar + mobile sheet) -->
{#snippet filterPanel()}
  <div class="space-y-6">
    <!-- Active filter summary -->
    {#if hasActiveFilters}
      <button
        onclick={clearFilters}
        class="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <RotateCcw class="size-3" />
        {m.search_clear_all_filters()}
      </button>
    {/if}

    <!-- Folder filter -->
    {#if folders.length > 0}
      <div>
        <h4
          class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <Folder class="size-3.5" />
          {m.search_folders()}
        </h4>
        <div class="space-y-0.5">
          {#each folders as folder}
            <button
              onclick={() => toggleFolder(folder)}
              class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors {activeFolder === folder
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
            >
              <span class="truncate">{folder}</span>
              {#if activeFolder === folder}
                <X class="size-3 shrink-0" />
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Tag filter -->
    {#if tags.length > 0}
      <div>
        <h4
          class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <Tag class="size-3.5" />
          {m.search_tags()}
        </h4>
        <div class="flex flex-wrap gap-1.5">
          {#each tags as tag}
            <button
              onclick={() => toggleTag(tag)}
              class="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors {activeTags.includes(tag)
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
            >
              {tag}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Date range filter -->
    <div>
      <h4
        class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        <Calendar class="size-3.5" />
        {m.search_date_range()}
      </h4>
      <div class="space-y-2">
        <div>
          <label for="dateFrom" class="text-xs text-muted-foreground">{m.search_date_from()}</label>
          <input
            id="dateFrom"
            type="date"
            bind:value={dateFrom}
            onchange={applyDateRange}
            class="mt-0.5 flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label for="dateTo" class="text-xs text-muted-foreground">{m.search_date_to()}</label>
          <input
            id="dateTo"
            type="date"
            bind:value={dateTo}
            onchange={applyDateRange}
            class="mt-0.5 flex h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>
    </div>
  </div>
{/snippet}

<!-- Loading state -->
{#snippet loadingState()}
  <div class="space-y-4">
    {#each Array(3) as _, i}
      <div class="animate-pulse rounded-lg border border-border bg-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="h-5 w-2/3 rounded bg-muted"></div>
          <div class="h-5 w-12 rounded-full bg-muted"></div>
        </div>
        <div class="mt-3 space-y-2">
          <div class="h-4 w-full rounded bg-muted"></div>
          <div class="h-4 w-5/6 rounded bg-muted"></div>
        </div>
        <div class="mt-3 flex gap-4">
          <div class="h-3.5 w-20 rounded bg-muted"></div>
          <div class="h-3.5 w-28 rounded bg-muted"></div>
          <div class="h-3.5 w-24 rounded bg-muted"></div>
        </div>
      </div>
    {/each}
    <div class="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 class="size-4 animate-spin" />
      {m.search_searching()}
    </div>
  </div>
{/snippet}

<!-- Results list -->
{#snippet resultsList()}
  <div>
    <div class="mb-4 flex items-center justify-between gap-3">
      <p class="text-sm text-muted-foreground">
        {(searchResponse?.total ?? 0) === 1 ? m.search_result_for({count: searchResponse!.total}) : m.search_results_for({count: searchResponse!.total})}
        "<span class="font-medium text-foreground">{data.query}</span>"
      </p>
      <select
        bind:value={sortOrder}
        class="rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Sort results"
      >
        <option value="relevance">Relevance</option>
        <option value="date_desc">Date (newest first)</option>
        <option value="date_asc">Date (oldest first)</option>
        <option value="name_asc">Name (A-Z)</option>
        <option value="name_desc">Name (Z-A)</option>
      </select>
    </div>

    <div class="space-y-3">
      {#each searchResponse?.items ?? [] as result (result.id)}
        <SearchResult
          id={result.id}
          title={result.title}
          snippet={result.snippet}
          score={result.score}
          folderName={result.folder_id ?? ""}
          tags={[]}
          createdAt={result.created_at}
          query={data.query}
        />
      {/each}
    </div>

    <!-- Pagination -->
    {#if totalPages > 1}
      <nav class="mt-8 flex items-center justify-center gap-1.5" aria-label={m.search_pages_aria()}>
        <button
          onclick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label={m.search_previous_page()}
          class="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-2.5 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <ChevronLeft class="h-4 w-4" />
        </button>

        {#each Array(totalPages) as _, i}
          {@const pageNum = i + 1}
          {#if totalPages <= 7 || pageNum === 1 || pageNum === totalPages || (pageNum >= currentPage - 1 && pageNum <= currentPage + 1)}
            <button
              onclick={() => goToPage(pageNum)}
              aria-label={m.search_page_number({num: pageNum})}
              aria-current={pageNum === currentPage ? "page" : undefined}
              class="inline-flex h-9 min-w-9 items-center justify-center rounded-md px-2.5 text-sm font-medium shadow-sm transition-colors {pageNum === currentPage
                ? 'bg-primary text-primary-foreground'
                : 'border border-input bg-background text-muted-foreground hover:bg-muted hover:text-foreground'}"
            >
              {pageNum}
            </button>
          {:else if pageNum === 2 || pageNum === totalPages - 1}
            <span class="px-1 text-muted-foreground">...</span>
          {/if}
        {/each}

        <button
          onclick={() => goToPage(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label={m.search_next_page()}
          class="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-2.5 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <ChevronRight class="h-4 w-4" />
        </button>
      </nav>
    {/if}
  </div>
{/snippet}

<!-- No results -->
{#snippet noResults()}
  <div class="flex flex-col items-center justify-center py-20 text-center">
    <FileSearch class="mb-4 h-16 w-16 text-muted-foreground/40" />
    <h2 class="text-xl font-semibold text-foreground">{m.search_no_results()}</h2>
    <p class="mt-2 max-w-sm text-sm text-muted-foreground">
      {m.search_no_results_query({query: data.query ?? ""})}
      {m.search_no_results_tip()}
    </p>
    <div class="mt-6 flex gap-3">
      {#if hasActiveFilters}
        <button
          onclick={clearFilters}
          class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-4 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        >
          <RotateCcw class="size-3.5" />
          {m.search_clear_filters()}
        </button>
      {/if}
      <button
        onclick={clearSearch}
        class="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
      >
        {m.search_new_search()}
      </button>
    </div>

    <!-- Search suggestions -->
    <div class="mt-10">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {m.search_try_searching()}
      </p>
      <div class="flex flex-wrap justify-center gap-2">
        {#each ["getting started", "docker deployment", "API reference", "authentication", "embeddings"] as suggestion}
          <button
            onclick={() => {
              query = suggestion;
              goto(buildUrl({ q: suggestion, page: "1" }), {
                replaceState: true,
              });
            }}
            class="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-muted hover:text-foreground"
          >
            {suggestion}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/snippet}

<!-- Empty state (no query yet) -->
{#snippet emptyState()}
  <div class="flex flex-col items-center justify-center py-20 text-center">
    <Search class="mb-4 h-16 w-16 text-muted-foreground/40" />
    <h2 class="text-xl font-semibold text-foreground">
      {m.search_empty_title()}
    </h2>
    <p class="mt-2 max-w-sm text-sm text-muted-foreground">
      {m.search_empty_description()}
    </p>

    <div class="mt-8">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {m.search_popular()}
      </p>
      <div class="flex flex-wrap justify-center gap-2">
        {#each ["getting started", "docker deployment", "API reference", "authentication", "embeddings", "Svelte 5"] as suggestion}
          <button
            onclick={() => {
              query = suggestion;
              goto(buildUrl({ q: suggestion, page: "1" }), {
                replaceState: true,
              });
            }}
            class="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-muted hover:text-foreground"
          >
            {suggestion}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/snippet}
