<script lang="ts">
import { Calendar, Check, Folder, Tag } from "lucide-svelte";
import { goto } from "$app/navigation";
import type { SearchExplanation } from "$lib/api/search";
import * as m from "$lib/paraglide/messages.js";

interface Props {
	id: string;
	title: string;
	snippet: string; // may contain <mark> tags
	score: number;
	folderName: string;
	tags: Array<{ id: string; name: string; color: string | null }>;
	createdAt: string;
	query?: string;
	/**
	 * When `true`, the result's title was a strong match for the query
	 * and the backend's title-first boost applied a 3x score multiplier.
	 * Surface a small green badge in the header so the user can see why
	 * the result is at the top of the list.
	 */
	titleMatch?: boolean;
	explanations?: SearchExplanation[];
	chunks?: Array<{
		chunkIndex: number;
		chunkText: string;
		charStart: number;
		charEnd: number;
		score: number;
	}>;
}

const {
	id,
	title,
	snippet,
	score,
	folderName,
	tags,
	createdAt,
	query = "",
	titleMatch = false,
	explanations = [],
}: Props = $props();

const highlightedSnippet = $derived(highlightText(snippet, query));

const scorePercent = $derived(Math.round(score * 100));

const scoreColor = $derived(
	titleMatch
		? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
		: scorePercent >= 90
			? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
			: scorePercent >= 75
				? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
				: "bg-muted text-muted-foreground",
);

const formattedDate = $derived(
	new Date(createdAt).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	}),
);

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function highlightText(text: string, q: string): string {
	if (!q) return escapeHtml(text);
	const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const safe = escapeHtml(text);
	return safe.replace(new RegExp(`(${escapedQuery})`, "gi"), "<mark>$1</mark>");
}
</script>

<a
  href="/docs/{id}"
  onclick={(e) => {
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      goto(`/docs/${id}`);
    }
  }}
  class="group block rounded-lg border border-border bg-card p-5 shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
>
  <!-- Header: title + score -->
  <div class="flex items-start justify-between gap-3">
    <h3
      class="text-lg font-semibold leading-snug text-foreground group-hover:text-primary transition-colors"
    >
      {title}
    </h3>
    <div class="flex shrink-0 items-center gap-1.5">
      {#if titleMatch}
        <span
          class="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
          title={m.search_title_match_badge()}
        >
          <Check class="size-3" />
          {m.search_title_match_badge()}
        </span>
      {/if}
      <span
        class="rounded-full px-2.5 py-0.5 text-xs font-medium {scoreColor}"
      >
        {scorePercent}%
      </span>
    </div>
  </div>

  <!-- Snippet with highlighted terms -->
  <p
    class="mt-2 text-sm leading-relaxed text-muted-foreground [&_mark]:rounded-sm [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:text-foreground dark:[&_mark]:bg-yellow-900/60"
  >
    {@html highlightedSnippet}
  </p>

  {#if explanations.length > 0}
    <div class="mt-3 flex flex-wrap gap-1.5" aria-label="Search match explanations">
      {#each explanations.slice(0, 3) as explanation, index (index)}
        <span class="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {explanation.label}
        </span>
      {/each}
    </div>
  {/if}

  <!-- Meta row: folder + tags + date -->
  <div
    class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
  >
    {#if folderName}
      <span class="inline-flex items-center gap-1">
        <Folder class="size-3.5" />
        {folderName}
      </span>
    {/if}

    {#if tags.length > 0}
      {#each tags as tag (tag.id)}
        <span class="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
          {#if tag.color}
            <span class="inline-block size-2 rounded-full" style="background-color: {tag.color}"></span>
          {/if}
          {tag.name}
        </span>
      {/each}
    {/if}

    <span class="inline-flex items-center gap-1">
      <Calendar class="size-3.5" />
      {formattedDate}
    </span>
  </div>
</a>
