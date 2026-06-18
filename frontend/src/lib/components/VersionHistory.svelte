<script lang="ts">
import { Clock, History, Loader2, RotateCcw } from "lucide-svelte";
import { onMount } from "svelte";
import { apiFetch } from "$lib/api/client";
import * as m from "$lib/paraglide/messages.js";

interface Version {
	id: string;
	documentId: string;
	content: string;
	contentJson?: unknown;
	createdBy: string;
	createdAt: string;
}

const { documentId }: { documentId: string } = $props();

let versions = $state<Version[]>([]);
let loading = $state(true);
let loadError = $state<string | null>(null);

onMount(async () => {
	try {
		versions = await apiFetch<Version[]>(
			`/api/documents/${documentId}/versions`,
		);
	} catch (e) {
		loadError = e instanceof Error ? e.message : String(e);
		console.error("Failed to load versions", e);
	} finally {
		loading = false;
	}
});

/** Trim content to a single-line preview (strip markdown + truncate). */
function previewFromContent(content: string | undefined): string {
	if (!content) return "";
	const stripped = content
		.replace(/```[\s\S]*?```/g, "")
		.replace(/[#*_`>~-]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return stripped.length > 100 ? `${stripped.slice(0, 100)}…` : stripped;
}

function relativeTime(value: string | Date): string {
	const created = typeof value === "string" ? new Date(value) : value;
	const diff = Date.now() - created.getTime();
	if (Number.isNaN(diff)) return "";
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return m.time_minutes_ago({ count: 0 });
	if (mins < 60) return m.time_minutes_ago({ count: mins });
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return m.time_hours_ago({ count: hrs });
	return m.time_days_ago({ count: Math.floor(hrs / 24) });
}
</script>

<div class="flex flex-col gap-2 p-4">
  <div class="flex items-center gap-2 text-sm font-medium text-foreground">
    <History class="h-4 w-4" />
    <span>{m.version_history_title()}</span>
  </div>

  {#if loading}
    <div class="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 class="h-3.5 w-3.5 animate-spin" />
      <span>{m.action_loading()}</span>
    </div>
  {:else if loadError}
    <p class="py-4 text-center text-xs text-destructive">{loadError}</p>
  {:else if versions.length === 0}
    <p class="py-4 text-center text-xs text-muted-foreground">{m.version_history_empty()}</p>
  {:else}
    <div class="flex flex-col gap-1 overflow-y-auto max-h-80">
      {#each versions as version (version.id)}
        <div class="flex items-start gap-3 rounded-md border border-border p-3 text-sm hover:bg-accent transition-colors">
          <Clock class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-muted-foreground">{relativeTime(version.createdAt)}</span>
              <button
                class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
                title={m.version_restore()}
              >
                <RotateCcw class="h-3 w-3" />
                {m.version_restore_short()}
              </button>
            </div>
            <p class="mt-1 truncate text-xs text-muted-foreground">{previewFromContent(version.content)}</p>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
