<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { Clock, FileText, Plus, Tag, Upload } from "lucide-svelte";
import {
	createDocument,
	type Document,
	importDocument,
	listDocuments,
} from "$lib/api/documents";
import * as m from "$lib/paraglide/messages.js";
import SearchBar from "$lib/components/SearchBar.svelte";
import ScrollToTop from "$lib/components/ScrollToTop.svelte";
import { stripMarkdown } from "$lib/utils/strip-markdown";

let recentDocs = $state<Document[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let importInput = $state<HTMLInputElement | undefined>(undefined);

onMount(async () => {
	try {
		const res = await listDocuments({ limit: 5 });
		recentDocs = res.items;
	} catch (err) {
		error = err instanceof Error ? err.message : m.doc_load_error();
	} finally {
		loading = false;
	}
});

function triggerImport() {
	importInput?.click();
}

async function handleNewDocument() {
	try {
		const doc = await createDocument({
			title: "Untitled Document",
			content: "",
		});
		goto(`/docs/${doc.id}`);
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to create document";
	}
}

async function handleImportFile(e: Event) {
	const input = e.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;
	try {
		await importDocument(file);
		const res = await listDocuments({ limit: 5 });
		recentDocs = res.items;
	} catch (err) {
		error = err instanceof Error ? err.message : "Import failed";
	}
	input.value = "";
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
          <input type="file" accept=".md,.txt,.json,.markdown" class="hidden" bind:this={importInput} onchange={handleImportFile} />
          <button onclick={triggerImport} class="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground">
            <Upload class="size-4" />
            Import
          </button>
          <button onclick={handleNewDocument} class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90">
            <Plus class="size-4" />
            {m.dashboard_new_document()}
          </button>
        </div>
      </div>

      <!-- Search -->
      <SearchBar class="mb-8" />

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
            onclick={async () => { loading = true; error = null; try { const res = await listDocuments({ limit: 5 }); recentDocs = res.items; } catch (e) { error = e instanceof Error ? e.message : m.doc_load_error(); } finally { loading = false; } }}
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
              class="group rounded-lg border border-border bg-card p-4 shadow-sm transition-all hover:shadow-md hover:border-primary/30"
            >
              <div class="mb-2 flex items-start justify-between">
                <div class="flex items-center gap-2">
                  <FileText class="size-4 shrink-0 text-muted-foreground" />
                  <h3 class="font-medium leading-tight group-hover:text-primary">{doc.title}</h3>
                </div>
              </div>
              <p class="mb-3 text-sm text-muted-foreground line-clamp-2">{stripMarkdown(doc.content || "").slice(0, 120)}</p>
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock class="size-3" />
                  {relativeTime(doc.updatedAt)}
                </div>
                {#if doc.tags?.length}
                  <div class="flex items-center gap-1">
                    {#each doc.tags.slice(0, 2) as tag}
                      <span class="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                        <Tag class="size-2.5" />
                        {tag}
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

<ScrollToTop />
