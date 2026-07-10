<!-- ImportProgress.svelte — Modal-style progress overlay for multi-file
     document import. Renders a list of files with per-file status
     (uploading, processing, done, error) and a summary at the bottom
     when all uploads have settled. The parent component is responsible
     for driving the per-file state changes; this component is a
     presentational surface that mirrors that state. -->
<script lang="ts">
import {
	Check,
	ChevronRight,
	FileText,
	Loader2,
	X,
	XCircle,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import * as m from "$lib/paraglide/messages.js";

export type ImportItemStatus = "uploading" | "processing" | "done" | "error";

export interface ImportItem {
	filename: string;
	status: ImportItemStatus;
	documentId?: string;
	error?: string;
}

const {
	open = true,
	items,
	onClose,
}: {
	open?: boolean;
	items: ImportItem[];
	onClose?: () => void;
} = $props();

const total = $derived(items.length);
const done = $derived(items.filter((i) => i.status === "done").length);
const failed = $derived(items.filter((i) => i.status === "error").length);
const inFlight = $derived(
	items.filter((i) => i.status === "uploading" || i.status === "processing")
		.length,
);
const settled = $derived(inFlight === 0);
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    onclick={onClose}
    onkeydown={(e: KeyboardEvent) => {
      if (e.key === "Escape" && settled && onClose) {
        e.preventDefault();
        onClose();
      }
    }}
    role="presentation"
  >
    <div
      class="w-full max-w-md overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={m.import_progress_title()}
    >
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 class="text-sm font-semibold">{m.import_progress_title()}</h2>
          {#if total > 0}
            <p class="mt-0.5 text-xs text-muted-foreground">
              {m.import_progress_total({ done, total })}
            </p>
          {/if}
        </div>
        <button
          type="button"
          onclick={onClose}
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          aria-label={m.action_close()}
          disabled={!settled}
        >
          <X class="size-4" />
        </button>
      </div>

      <div class="max-h-[60vh] overflow-y-auto">
        {#if items.length === 0}
          <div class="px-4 py-8 text-center text-sm text-muted-foreground">
            {m.import_progress_empty()}
          </div>
        {:else}
          <ul class="divide-y divide-border">
            {#each items as item, idx (idx)}
              <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
                <FileText class="size-4 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate">{item.filename}</span>
                <span class="inline-flex shrink-0 items-center gap-1 text-xs">
                  {#if item.status === "uploading"}
                    <Loader2 class="size-3.5 animate-spin text-muted-foreground" />
                    <span class="text-muted-foreground">
                      {m.import_progress_uploading()}
                    </span>
                  {:else if item.status === "processing"}
                    <Loader2 class="size-3.5 animate-spin text-muted-foreground" />
                    <span class="text-muted-foreground">
                      {m.import_progress_processing()}
                    </span>
                  {:else if item.status === "done"}
                    <Check class="size-3.5 text-emerald-600 dark:text-emerald-400" />
                    {#if item.documentId}
                      <a
                        href={`/docs/${item.documentId}`}
                        class="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
                      >
                        <span>View</span>
                        <ChevronRight class="size-3" />
                      </a>
                    {:else}
                      <span class="text-emerald-700 dark:text-emerald-400">
                        {m.import_progress_done()}
                      </span>
                    {/if}
                  {:else}
                    <XCircle class="size-3.5 text-destructive" />
                    <span class="text-destructive" title={item.error ?? ""}>
                      {m.import_progress_error()}
                    </span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if settled && total > 0}
        <div class="flex items-center justify-between gap-2 border-t border-border bg-muted/50 px-4 py-3 text-sm">
          <p class="font-medium">
            {m.import_progress_summary({
              imported: done,
              failed,
            })}
          </p>
          <div class="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onclick={onClose}
              class="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {m.import_progress_close()}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}
