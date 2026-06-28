<script lang="ts">
import {
	Check,
	Clock,
	Copy,
	FileText,
	Loader2,
	Plus,
	Upload,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import { goto } from "$app/navigation";
import {
	createDocument,
	type Document,
	getDocument,
	importDocuments,
	listDocuments,
} from "$lib/api/documents";
import ImportProgress, {
	type ImportItem,
} from "$lib/components/ImportProgress.svelte";
import SearchBar from "$lib/components/SearchBar.svelte";
import * as m from "$lib/paraglide/messages.js";
import {
	getSelectedTag,
	refreshDocs,
	setSelectedTag,
} from "$lib/stores/tag-store.svelte";
import { copyToClipboard } from "$lib/utils/clipboard.js";
import { stripMarkdown } from "$lib/utils/strip-markdown";

let recentDocs = $state<Document[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let importInput = $state<HTMLInputElement | undefined>(undefined);
let copiedDocId = $state<string | null>(null);
let copyLoadingDocId = $state<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

// --- Import progress (multi-file) -------------------------------------------
// `importItems` is the source of truth for the ImportProgress overlay.
// We seed one entry per picked file in `uploading`, then flip them to
// `processing` while the network request is in flight, finally to
// `done` / `error` based on the backend's per-file result.
let importOpen = $state(false);
let importItems = $state<ImportItem[]>([]);

async function loadDocs(tagId: string | null = getSelectedTag()) {
	loading = true;
	error = null;
	try {
		const res = await listDocuments({
			limit: 6,
			...(tagId ? { tag: tagId } : {}),
		});
		recentDocs = res.items;
	} catch (err) {
		error = err instanceof Error ? err.message : m.doc_load_error();
	} finally {
		loading = false;
	}
}

// Load on mount and reload whenever the shared selected tag changes (driven
// by the sidebar TagList), so a tag selection filters the dashboard too.
$effect(() => {
	const tag = getSelectedTag();
	void loadDocs(tag);
});

onDestroy(() => {
	if (copyTimer) {
		clearTimeout(copyTimer);
		copyTimer = null;
	}
});

async function handleCopyContent(e: MouseEvent, docId: string) {
	e.preventDefault();
	e.stopPropagation();
	if (typeof window === "undefined") return;
	const cached = recentDocs.find((d) => d.id === docId);
	let text = "";
	copyLoadingDocId = docId;
	try {
		const full = await getDocument(docId);
		text = full.content ?? "";
	} catch (err) {
		console.error("Dashboard: failed to fetch full document for copy", err);
		text = cached?.excerpt ?? cached?.content ?? "";
	} finally {
		copyLoadingDocId = null;
	}
	if (!text) return;
	const ok = await copyToClipboard(text);
	if (!ok) return;
	copiedDocId = docId;
	if (copyTimer) clearTimeout(copyTimer);
	copyTimer = setTimeout(() => {
		copiedDocId = null;
		copyTimer = null;
	}, 2000);
}

function triggerImport() {
	importInput?.click();
}

async function handleNewDocument() {
	try {
		const doc = await createDocument({
			title: m.dashboard_untitled_document(),
			content: "",
		});
		refreshDocs();
		goto(`/docs/${doc.id}`);
	} catch (err) {
		error = err instanceof Error ? err.message : m.error_document_save();
	}
}

async function handleImportFile(e: Event) {
	const input = e.target as HTMLInputElement;
	const files = input.files ? Array.from(input.files) : [];
	if (files.length === 0) return;

	// Seed the progress overlay. The component will re-render as we
	// transition each item through uploading → processing → done/error.
	importItems = files.map((f) => ({
		filename: f.name,
		status: "uploading",
	}));
	importOpen = true;

	// Move the entire batch into "processing" once the request is in
	// flight. The backend's import endpoint does parsing server-side
	// so we can show that as a single intermediate state.
	for (const item of importItems) {
		item.status = "processing";
	}
	// Svelte 5 deep-update via reassign so the list re-renders.
	importItems = [...importItems];

	try {
		const res = await importDocuments(files);
		// Reconcile the per-file results from the response back into the
		// local list. Match by filename (the backend echoes it back in
		// the ImportResult).
		importItems = importItems.map((item) => {
			const r = res.items.find((x) => x.filename === item.filename);
			if (!r) {
				return { ...item, status: "error", error: "No result for file" };
			}
			if (r.status === "ok" && r.document) {
				return {
					...item,
					status: "done",
					documentId: r.document.id,
				};
			}
			return {
				...item,
				status: "error",
				error: r.error ?? "Import failed",
			};
		});
		// Nudge sidebar components (RecentDocs, FolderTree) to refetch
		// their document lists. They subscribe to the doc refresh nonce
		// via $effect and re-load on change, so the imported documents
		// appear immediately without a page reload.
		refreshDocs();
		await loadDocs();
	} catch (err) {
		// Network / unknown failure: mark every still-pending item as
		// failed and surface the error in the top-level error banner.
		importItems = importItems.map((item) => ({
			...item,
			status: "error",
			error: err instanceof Error ? err.message : m.error_generic(),
		}));
		error = err instanceof Error ? err.message : m.error_generic();
	} finally {
		input.value = "";
	}
}

function closeImport() {
	importOpen = false;
	// Give the modal's exit transition a moment before clearing state
	// so a re-open with the same files doesn't flicker.
	setTimeout(() => {
		importItems = [];
	}, 200);
}

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 60) return m.time_minutes_ago({ count: mins });
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return m.time_hours_ago({ count: hrs });
	return m.time_days_ago({ count: Math.floor(hrs / 24) });
}

const hasDocs = $derived(recentDocs.length > 0);

const availableTags = $derived(
	(() => {
		const seen = new Map<
			string,
			{ id: string; name: string; color?: string | null }
		>();
		for (const doc of recentDocs) {
			for (const t of doc.tags ?? []) {
				if (!seen.has(t.id))
					seen.set(t.id, { id: t.id, name: t.name, color: t.color });
			}
		}
		return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
	})(),
);

function selectTag(tagId: string | null) {
	// Drives the shared store; the $effect above reloads the doc list.
	setSelectedTag(tagId);
}
</script>

<svelte:head>
  <title>{m.dashboard_page_title()}</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-6 py-8">
      <!-- Header -->
      <div class="mb-8 flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-semibold tracking-tight">{m.dashboard_title()}</h1>
          <p class="text-sm text-muted-foreground">{m.dashboard_subtitle()}</p>
        </div>
        <div class="flex items-center gap-2">
          <input type="file" accept=".md,.txt,.json,.markdown,.docx" multiple class="hidden" bind:this={importInput} onchange={handleImportFile} />
          <button onclick={triggerImport} class="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground">
            <Upload class="size-4" />
            {m.dashboard_import()}
          </button>
          <button onclick={handleNewDocument} class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90">
            <Plus class="size-4" />
            {m.dashboard_new_document()}
          </button>
        </div>
      </div>

      <!-- Search -->
      <SearchBar class="mb-8" />

      <!-- Tag Filter Bar -->
      {#if !loading && !error && availableTags.length > 0}
        <div class="mb-6 flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-muted-foreground">{m.dashboard_filter_label()}</span>
          <button
            type="button"
            onclick={() => selectTag(null)}
            class="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors {getSelectedTag() === null ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground'}"
            aria-pressed={getSelectedTag() === null}
          >
            {m.search_filter_all()}
          </button>
          {#each availableTags as tag (tag.id)}
            <button
              type="button"
              onclick={() => selectTag(tag.id)}
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors {getSelectedTag() === tag.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground'}"
              aria-pressed={getSelectedTag() === tag.id}
            >
              <span class="size-2 rounded-full" style="background-color: {tag.color || '#cccccc'}"></span>
              {tag.name}
            </button>
          {/each}
        </div>
      {/if}

      {#if loading}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {#each Array(3) as _}
            <div class="rounded-lg border border-border bg-card p-4 animate-pulse">
              <div class="mb-2 h-5 w-3/4 rounded bg-muted"></div>
              <div class="mb-1 h-4 w-full rounded bg-muted"></div>
              <div class="mb-3 h-4 w-2/3 rounded bg-muted"></div>
              <div class="h-3 w-1/3 rounded bg-muted"></div>
            </div>
          {/each}
        </div>
      {:else if error}
        <div class="flex flex-col items-center justify-center py-20 text-center">
          <div class="mb-4 flex size-16 items-center justify-center rounded-full bg-destructive/10">
            <FileText class="size-8 text-destructive" />
          </div>
          <h2 class="mb-2 text-lg font-semibold">{m.dashboard_error_title()}</h2>
          <p class="mb-6 max-w-sm text-sm text-muted-foreground">{error}</p>
          <button
            onclick={() => loadDocs()}
            class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
          >
            {m.dashboard_error_retry()}
          </button>
        </div>
      {:else if hasDocs}
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {#each recentDocs as doc (doc.id)}
            <a
              href={`/docs/${doc.id}`}
              class="group relative rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:shadow-md hover:border-primary/30"
            >
              <button
                type="button"
                class="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {copiedDocId === doc.id || copyLoadingDocId === doc.id ? 'opacity-100' : ''}"
                aria-label={m.action_copy_content()}
                title={m.action_copy_content()}
                disabled={copyLoadingDocId === doc.id}
                onclick={(e: MouseEvent) => void handleCopyContent(e, doc.id)}
              >
                {#if copyLoadingDocId === doc.id}
                  <Loader2 class="size-3.5 animate-spin" />
                {:else if copiedDocId === doc.id}
                  <Check class="size-3.5" />
                {:else}
                  <Copy class="size-3.5" />
                {/if}
              </button>
              <div class="mb-2 flex items-start justify-between pr-8">
                <div class="flex items-center gap-2">
                  <FileText class="size-4 shrink-0 text-muted-foreground" />
                  <h3 class="font-medium leading-tight group-hover:text-primary">{doc.title}</h3>
                </div>
              </div>
              <p class="mb-3 text-sm text-muted-foreground line-clamp-2">{stripMarkdown(doc.content || "").slice(0, 120)}</p>
              <div class="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                <span class="flex items-center gap-1 shrink-0">
                  <Clock class="size-3" />
                  {relativeTime(doc.updatedAt)}
                </span>
                {#if doc.tags?.length}
                  <div class="flex flex-wrap items-center gap-1.5">
                    {#each doc.tags as tag (tag.id)}
                      <span class="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                        <span class="inline-block size-2 rounded-full" style="background-color: {tag.color}"></span>
                        {tag.name}
                      </span>
                    {/each}
                  </div>
                {/if}
              </div>
            </a>
          {/each}
        </div>
      {:else}
        <!-- Empty State -->
        <div class="flex flex-col items-center justify-center py-20 text-center">
          <div class="mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
            <FileText class="size-8 text-muted-foreground" />
          </div>
          <h2 class="mb-2 text-lg font-semibold">{m.dashboard_empty_title()}</h2>
          <p class="mb-6 max-w-sm text-sm text-muted-foreground">
            {m.dashboard_empty_description()}
          </p>
          <button onclick={handleNewDocument} class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90">
            <Plus class="size-4" />
            {m.dashboard_new_document()}
          </button>
        </div>
      {/if}
    </div>

<ImportProgress open={importOpen} items={importItems} onClose={closeImport} />
