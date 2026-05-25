<script lang="ts">
  import { Folder, Tag, Calendar } from "lucide-svelte";

  interface Props {
    id: string;
    title: string;
    snippet: string; // may contain <mark> tags
    score: number;
    folderName: string;
    tags: string[];
    createdAt: string;
    query?: string;
  }

  let { id, title, snippet, score, folderName, tags, createdAt, query = "" }: Props =
    $props();

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

  let highlightedSnippet = $derived(highlightText(snippet, query));

  let scorePercent = $derived(Math.round(score * 100));

  let scoreColor = $derived(
    scorePercent >= 90
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : scorePercent >= 75
        ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
        : "bg-muted text-muted-foreground",
  );

  let formattedDate = $derived(
    new Date(createdAt).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  );
</script>

<a
  href="/docs/{id}"
  class="group block rounded-lg border border-border bg-card p-5 shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
>
  <!-- Header: title + score -->
  <div class="flex items-start justify-between gap-3">
    <h3
      class="text-lg font-semibold leading-snug text-foreground group-hover:text-primary transition-colors"
    >
      {title}
    </h3>
    <span
      class="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium {scoreColor}"
    >
      {scorePercent}%
    </span>
  </div>

  <!-- Snippet with highlighted terms -->
  <p
    class="mt-2 text-sm leading-relaxed text-muted-foreground [&_mark]:rounded-sm [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:text-foreground dark:[&_mark]:bg-yellow-900/60"
  >
    {@html highlightedSnippet}
  </p>

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
      <span class="inline-flex items-center gap-1">
        <Tag class="size-3.5" />
        {tags.join(", ")}
      </span>
    {/if}

    <span class="inline-flex items-center gap-1">
      <Calendar class="size-3.5" />
      {formattedDate}
    </span>
  </div>
</a>
