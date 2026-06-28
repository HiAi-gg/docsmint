<script lang="ts">
import {
	Calendar,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	FileSearch,
	Folder,
	FolderKanban,
	Loader2,
	RotateCcw,
	Search,
	SlidersHorizontal,
	Tag,
	X,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import { type Category, listCategories } from "$lib/api/categories";
import { type Document, listDocuments } from "$lib/api/documents";
import { listFolders } from "$lib/api/folders";
import { getFilterOptions, type SearchResponse, search } from "$lib/api/search";
import DatePicker from "$lib/components/DatePicker.svelte";
import SearchResult from "$lib/components/SearchResult.svelte";
import { Badge } from "$lib/components/ui/badge";
import * as m from "$lib/paraglide/messages.js";
import { getSelectedTagName } from "$lib/stores/tag-store.svelte";
import type { Folder as FolderType } from "$lib/types.js";

const { data } = $props();

// --- State -------------------------------------------------------------------
let query = $state("");
let activeFolder = $state("");
let activeTags = $state<string[]>([]);
// activeCategoryId is the UUID of the currently selected category filter.
// Empty string means "no category filter" (the default).
let activeCategoryId = $state("");
let dateFrom = $state("");
let dateTo = $state("");
let currentPage = $state(1);
let sortOrder = $state<
	"relevance" | "date_desc" | "date_asc" | "name_asc" | "name_desc"
>("relevance");

// Collapsible filters state
let foldersExpanded = $state(true);
let categoriesExpanded = $state(true);

// Flat data for local search
let allDocuments = $state<Document[]>([]);
let allFolders = $state<FolderType[]>([]);
let allCategories = $state<Category[]>([]);

$effect(() => {
	query = data.query ?? "";
	activeFolder = data.filters?.folder ?? "";
	activeTags = data.filters?.tags ?? [];
	activeCategoryId = data.filters?.category ?? "";
	dateFrom = data.filters?.dateFrom ?? "";
	dateTo = data.filters?.dateTo ?? "";
	currentPage = data.page ?? 1;
});

let searchResponse = $state<SearchResponse | null>(null);
let loading = $state(false);
let showFilters = $state(false);

let folders = $state<string[]>([]);
let tags = $state<Array<{ id: string; name: string; color: string | null }>>(
	[],
);
let categories = $state<Array<{ id: string; name: string }>>([]);

const PAGE_SIZE = 5;

// --- Derived -----------------------------------------------------------------
const totalPages = $derived(
	searchResponse ? Math.ceil(searchResponse.total / PAGE_SIZE) : 0,
);

const hasActiveFilters = $derived(
	activeFolder !== "" ||
		activeTags.length > 0 ||
		activeCategoryId !== "" ||
		dateFrom !== "" ||
		dateTo !== "",
);

// --- Effects -----------------------------------------------------------------

// Load filter options and local search lists on mount
$effect(() => {
	getFilterOptions().then((opts) => {
		folders = opts.folders;
		tags = opts.tags;
		categories = opts.categories;
	});

	listDocuments({ limit: 1000 }).then((res) => {
		allDocuments = res.items;
	});
	listFolders(null, true).then((res) => {
		allFolders = res;
	});
	listCategories().then((res) => {
		allCategories = res;
	});
});

const queryLower = $derived(query.trim().toLowerCase());

const matchingDocs = $derived.by(() => {
	if (!queryLower) return [];
	return allDocuments.filter((d) => d.title.toLowerCase().includes(queryLower));
});

const matchingFolders = $derived.by(() => {
	if (!queryLower) return [];
	return allFolders.filter((f) => f.name.toLowerCase().includes(queryLower));
});

const matchingCategories = $derived.by(() => {
	if (!queryLower) return [];
	return allCategories.filter((c) => c.name.toLowerCase().includes(queryLower));
});

const hasAnyLocalMatches = $derived(
	matchingDocs.length > 0 ||
		matchingFolders.length > 0 ||
		matchingCategories.length > 0,
);

// Run search when query or filters change
$effect(() => {
	const q = data.query;
	const p = data.page;
	const sort = sortOrder;
	const folder = activeFolder;
	const tags = activeTags;
	const category = activeCategoryId;
	const from = dateFrom;
	const to = dateTo;
	// Merge the shared selected tag (set from the sidebar TagList) into the
	// search filter so a tag picked anywhere also narrows search results.
	const sharedTag = getSelectedTagName();
	const effectiveTags =
		sharedTag && !tags.includes(sharedTag) ? [...tags, sharedTag] : tags;

	if (!q) {
		searchResponse = null;
		loading = false;
		return;
	}

	loading = true;

	search(q, p, PAGE_SIZE, sort, {
		folder: folder || undefined,
		tags: effectiveTags.length > 0 ? effectiveTags : undefined,
		category: category || undefined,
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

	const q = "q" in overrides ? overrides.q : query;
	const folder = "folder" in overrides ? overrides.folder : activeFolder;
	const t = "tags" in overrides ? overrides.tags : activeTags.join(",");
	const cat = "category" in overrides ? overrides.category : activeCategoryId;
	const df = "dateFrom" in overrides ? overrides.dateFrom : dateFrom;
	const dt = "dateTo" in overrides ? overrides.dateTo : dateTo;
	const p = "page" in overrides ? overrides.page : String(currentPage);

	if (q) params.set("q", q);
	if (folder) params.set("folder", folder);
	if (t) params.set("tags", t);
	if (cat) params.set("category", cat);
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

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		if (showFilters) {
			showFilters = false;
		} else if (query || hasActiveFilters) {
			clearSearch();
		}
	}
}

function clearSearch() {
	query = "";
	activeFolder = "";
	activeTags = [];
	activeCategoryId = "";
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

function toggleCategory(categoryId: string) {
	activeCategoryId = activeCategoryId === categoryId ? "" : categoryId;
	currentPage = 1;
	goto(buildUrl({ category: activeCategoryId, page: "1" }), {
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
	activeCategoryId = "";
	dateFrom = "";
	dateTo = "";
	currentPage = 1;
	goto(
		buildUrl({
			folder: undefined,
			tags: undefined,
			category: undefined,
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

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
  <title>{data.query ? m.search_title_with_query({query: data.query}) : m.search_title()} - {m.app_name()}</title>
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
      class="hidden lg:block w-56 shrink-0 space-y-6"
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
      <!-- Instant Title Matches -->
      {#if query.trim() && hasAnyLocalMatches}
        <div class="mb-6 space-y-4">
          <h3 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Instant Title Matches
          </h3>

          {#if matchingDocs.length > 0}
            <div class="space-y-2">
              <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">
                {m.nav_documents()}
              </h4>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {#each matchingDocs as doc (doc.id)}
                  <a
                    href="/docs/{doc.id}"
                    onclick={(e) => {
                      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
                        e.preventDefault();
                        goto(`/docs/${doc.id}`);
                      }
                    }}
                    class="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
                  >
                    <FileSearch class="size-4 shrink-0 text-muted-foreground" />
                    <span class="font-medium text-sm truncate">{doc.title}</span>
                  </a>
                {/each}
              </div>
            </div>
          {/if}

          {#if matchingFolders.length > 0}
            <div class="space-y-2">
              <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">
                {m.nav_folders()}
              </h4>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {#each matchingFolders as folder (folder.id)}
                  <a
                    href="/folders/{folder.id}"
                    onclick={(e) => {
                      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
                        e.preventDefault();
                        goto(`/folders/${folder.id}`);
                      }
                    }}
                    class="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
                  >
                    <Folder class="size-4 shrink-0 text-muted-foreground" />
                    <span class="font-medium text-sm truncate">{folder.name}</span>
                  </a>
                {/each}
              </div>
            </div>
          {/if}

          {#if matchingCategories.length > 0}
            <div class="space-y-2">
              <h4 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">
                {m.categories_title()}
              </h4>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {#each matchingCategories as category (category.id)}
                  <a
                    href="/folders#category-{category.id}"
                    onclick={(e) => {
                      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
                        e.preventDefault();
                        goto(`/folders#category-${category.id}`);
                      }
                    }}
                    class="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent"
                  >
                    <FolderKanban class="size-4 shrink-0 text-muted-foreground" />
                    <span class="font-medium text-sm truncate">{category.name}</span>
                  </a>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Server Search Results -->
      {#if query.trim()}
        <div class="border-t border-border/60 pt-6">
          <h3 class="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            AI-powered Semantic Search
          </h3>
          {#if loading}
            {@render loadingState()}
          {:else if searchResponse && searchResponse.items.length > 0}
            {@render resultsList()}
          {:else if !hasAnyLocalMatches}
            {@render noResults()}
          {/if}
        </div>
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
        <button
          type="button"
          onclick={() => (foldersExpanded = !foldersExpanded)}
          class="mb-2 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <span class="flex items-center gap-1.5">
            <Folder class="size-3.5" />
            {m.search_folders()}
          </span>
          {#if foldersExpanded}
            <ChevronDown class="size-3" />
          {:else}
            <ChevronRight class="size-3" />
          {/if}
        </button>
        {#if foldersExpanded}
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
        {/if}
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
          {#each tags as tag (tag.id)}
            <button
              onclick={() => toggleTag(tag.name)}
              class="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors {activeTags.includes(tag.name)
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
            >
              {#if tag.color}
                <span class="mr-1.5 inline-block size-2 rounded-full" style="background-color: {tag.color}"></span>
              {/if}
              {tag.name}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Category filter -->
    {#if categories.length > 0}
      <div>
        <button
          type="button"
          onclick={() => (categoriesExpanded = !categoriesExpanded)}
          class="mb-2 flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <span class="flex items-center gap-1.5">
            <FolderKanban class="size-3.5" />
            {m.categories_title()}
          </span>
          {#if categoriesExpanded}
            <ChevronDown class="size-3" />
          {:else}
            <ChevronRight class="size-3" />
          {/if}
        </button>
        {#if categoriesExpanded}
          <div class="space-y-0.5">
            {#each categories as category (category.id)}
              <button
                onclick={() => toggleCategory(category.id)}
                class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors {activeCategoryId === category.id
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
              >
                <span class="truncate">{category.name}</span>
                {#if activeCategoryId === category.id}
                  <X class="size-3 shrink-0" />
                {/if}
              </button>
            {/each}
          </div>
        {/if}
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
          <div class="mt-0.5">
            <DatePicker
              id="dateFrom"
              bind:value={dateFrom}
              onchange={applyDateRange}
              ariaLabel={m.search_date_from()}
              placeholder={m.search_date_from()}
            />
          </div>
        </div>
        <div>
          <label for="dateTo" class="text-xs text-muted-foreground">{m.search_date_to()}</label>
          <div class="mt-0.5">
            <DatePicker
              id="dateTo"
              bind:value={dateTo}
              onchange={applyDateRange}
              ariaLabel={m.search_date_to()}
              placeholder={m.search_date_to()}
            />
          </div>
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
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <p>
          {(searchResponse?.total ?? 0) === 1 ? m.search_result_for({count: searchResponse!.total}) : m.search_results_for({count: searchResponse!.total})}
          "<span class="font-medium text-foreground">{data.query}</span>"
        </p>
      </div>
      <select
        bind:value={sortOrder}
        class="rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={m.search_filter_label_aria()}
      >
        <option value="relevance">{m.sort_relevance()}</option>
        <option value="date_desc">{m.sort_date_newest()}</option>
        <option value="date_asc">{m.sort_date_oldest()}</option>
        <option value="name_asc">{m.sort_name_asc()}</option>
        <option value="name_desc">{m.sort_name_desc()}</option>
      </select>
    </div>

    <div class="space-y-3">
      {#each searchResponse?.items ?? [] as result (result.id)}
        <SearchResult
          id={result.id}
          title={result.title}
          snippet={result.snippet}
          score={result.score}
          folderName={result.folder_name ?? ""}
          tags={result.tags ?? []}
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
