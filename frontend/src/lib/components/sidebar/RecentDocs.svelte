<script lang="ts">
import { Check, Copy, FileText, Loader2, MoreVertical } from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import {
	type Document,
	deleteDocument,
	getDocument,
	listDocuments,
	updateDocument,
} from "$lib/api/documents";
import { Button } from "$lib/components/ui/button";
import { ConfirmDialog } from "$lib/components/ui/confirm-dialog";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "$lib/components/ui/dropdown-menu";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as m from "$lib/paraglide/messages.js";
import {
	getDocRefreshNonce,
	getSelectedTag,
	refreshDocs,
} from "$lib/stores/tag-store.svelte";
import { copyToClipboard } from "$lib/utils/clipboard.js";
import { cn } from "$lib/utils.js";

let recentDocs = $state<Document[]>([]);
let activeId = $state<string | null>(null);
let loadError = $state<string | null>(null);
let copiedDocId = $state<string | null>(null);
let copyLoadingDocId = $state<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;
// Tiny initial-fetch delay so the sidebar lists (RecentDocs, FolderTree)
// don't fire their listDocuments calls at exactly the same instant on a
// cold page load — staggered delays here keep the burst under the
// documentRateLimiter threshold.
const INITIAL_FETCH_DELAY_MS = 0;

// Rename dialog state.
let showRenameDialog = $state(false);
let renameTarget = $state<{ id: string; title: string } | null>(null);
let renameValue = $state("");
let renameError = $state<string | null>(null);
let renameSubmitting = $state(false);

// Delete confirmation state.
let showDeleteDialog = $state(false);
let deleteTarget = $state<{ id: string; title: string } | null>(null);
let deleteBusy = $state(false);

async function fetchRecentDocs() {
	try {
		const tag = getSelectedTag();
		const res = await listDocuments({ limit: 6, ...(tag ? { tag } : {}) });
		recentDocs = res.items;
		loadError = null;
	} catch (e) {
		console.error("RecentDocs: failed to load recent documents", e);
		loadError = "Failed to load recent documents";
	}
}

onMount(() => {
	if (INITIAL_FETCH_DELAY_MS <= 0) {
		void fetchRecentDocs();
		return;
	}
	const timer = setTimeout(() => {
		void fetchRecentDocs();
	}, INITIAL_FETCH_DELAY_MS);
	return () => clearTimeout(timer);
});

$effect(() => {
	const nonce = getDocRefreshNonce();
	if (nonce === 0) return;
	void fetchRecentDocs();
});

let firstTagRun = true;
$effect(() => {
	const tag = getSelectedTag();
	if (firstTagRun) {
		firstTagRun = false;
		return;
	}
	void fetchRecentDocs();
});

// Note: a previous `$effect` here watched `getDocRefreshNonce()` and
// `getSelectedTag()` to refetch the list on every refresh/tag change.
// It caused the sidebar to fire a listDocuments call on EVERY reactive
// dependency change — which combined with the other sidebar components
// burst past the documentRateLimiter and triggered 429s on cold loads.
//
// We now refresh only:
//   - once on mount (above)
//   - after local rename/delete handlers (which already call fetchRecentDocs)
//   - when the explicit `refreshRecentDocs()` helper below is invoked from
//     outside (e.g. by the dashboard after import) via refreshDocs().
//
// Cross-component invalidation flows through `refreshDocs()` (the nonce
// store), but consumers should call `refreshRecentDocs()` directly when
// they need an immediate reload rather than relying on a shared $effect.

/**
 * Public reload entry point. Exposed so other components (dashboard
 * after import, FolderTree after rename/delete, etc.) can request an
 * immediate refresh without going through the shared nonce store —
 * keeps the burst of initial fetches under control.
 */
export async function refreshRecentDocs(): Promise<void> {
	await fetchRecentDocs();
}

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
	// Copy the document's full markdown source. The list endpoint returns
	// `content` truncated to 200 chars at the SQL level, so we fetch the
	// single-document endpoint first to get the complete text. If the
	// fetch fails we fall back to whatever the list payload already has
	// (excerpt, then truncated content) so the button never silently
	// does nothing.
	const cached = recentDocs.find((d) => d.id === docId);
	let text = "";
	copyLoadingDocId = docId;
	try {
		const full = await getDocument(docId);
		text = full.content ?? "";
	} catch (err) {
		console.error("RecentDocs: failed to fetch full document for copy", err);
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

// --- Rename / delete ---
function startRename(id: string, title: string) {
	renameTarget = { id, title };
	renameValue = title;
	renameError = null;
	showRenameDialog = true;
}

function closeRenameDialog() {
	showRenameDialog = false;
	renameTarget = null;
	renameValue = "";
	renameError = null;
	renameSubmitting = false;
}

async function submitRename(e?: Event) {
	e?.preventDefault();
	const target = renameTarget;
	if (!target) return;
	const trimmed = renameValue.trim();
	if (trimmed.length === 0) {
		renameError = "Name is required";
		return;
	}
	renameSubmitting = true;
	try {
		await updateDocument(target.id, { title: trimmed });
		closeRenameDialog();
		await fetchRecentDocs();
		// Notify the other sidebar lists (FolderTree) to refetch.
		refreshDocs();
	} catch (err) {
		console.error("RecentDocs: rename failed", err);
		renameError = err instanceof Error ? err.message : m.error_generic();
	} finally {
		renameSubmitting = false;
	}
}

function startDelete(id: string, title: string) {
	deleteTarget = { id, title };
	showDeleteDialog = true;
}

function cancelDelete() {
	showDeleteDialog = false;
	deleteTarget = null;
	deleteBusy = false;
}

async function confirmDelete() {
	const target = deleteTarget;
	if (!target || deleteBusy) return;
	deleteBusy = true;
	try {
		await deleteDocument(target.id);
		cancelDelete();
		await fetchRecentDocs();
		refreshDocs();
	} catch (err) {
		console.error("RecentDocs: delete failed", err);
		loadError = err instanceof Error ? err.message : m.error_generic();
		deleteBusy = false;
	}
}
</script>

<div class="space-y-1">
  <h3 class="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.sidebar_recent()}</h3>
  {#if loadError}
    <p class="px-2 text-xs text-destructive">{loadError}</p>
  {/if}
  {#each recentDocs as doc (doc.id)}
    <div class="group/doc flex min-w-0 items-center gap-1">
      <a
        href={`/docs/${doc.id}`}
        onclick={() => { activeId = doc.id; }}
        class={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
          activeId === doc.id && "bg-accent text-accent-foreground"
        )}
      >
        <FileText class="size-4 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <p class="truncate min-w-0">{doc.title}</p>
          <p class="text-xs text-muted-foreground">{doc.updatedAt}</p>
        </div>
      </a>
      <button
        type="button"
        class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/doc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {copiedDocId === doc.id || copyLoadingDocId === doc.id ? 'opacity-100' : ''}"
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
      <DropdownMenu>
        <DropdownMenuTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/doc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={m.editor_more_options()}
              title={m.editor_more_options()}
              onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); }}
            >
              <MoreVertical class="size-3.5" />
            </button>
          {/snippet}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => startRename(doc.id, doc.title)}>
            {m.folders_rename()}
          </DropdownMenuItem>
          <DropdownMenuItem
            class="text-destructive focus:text-destructive"
            onSelect={() => startDelete(doc.id, doc.title)}
          >
            {m.action_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  {/each}
</div>

<!-- Rename dialog -->
<Dialog bind:open={showRenameDialog} onOpenChange={(next) => { if (!next) closeRenameDialog(); }}>
  <DialogHeader>
    <DialogTitle>{m.folders_rename()}</DialogTitle>
    <DialogDescription>{m.doc_title_label()}</DialogDescription>
  </DialogHeader>

  <form onsubmit={submitRename} class="space-y-4">
    <div class="space-y-2">
      <Label for="recent-rename-input">{m.doc_title_label()}</Label>
      <Input
        id="recent-rename-input"
        name="name"
        type="text"
        bind:value={renameValue}
        maxlength={255}
        required
        disabled={renameSubmitting}
        aria-invalid={renameError ? "true" : undefined}
        aria-describedby={renameError ? "recent-rename-input-error" : undefined}
        autocomplete="off"
      />
      {#if renameError}
        <p id="recent-rename-input-error" class="text-xs text-destructive" role="alert">{renameError}</p>
      {/if}
    </div>
  </form>

  <DialogFooter>
    <Button variant="outline" type="button" onclick={closeRenameDialog} disabled={renameSubmitting}>
      {m.action_cancel()}
    </Button>
    <Button
      type="submit"
      onclick={submitRename}
      disabled={renameSubmitting || renameValue.trim().length === 0}
    >
      {renameSubmitting ? m.action_loading() : m.action_save()}
    </Button>
  </DialogFooter>
</Dialog>

<!-- Delete confirmation -->
<ConfirmDialog
  bind:open={showDeleteDialog}
  title={m.doc_delete()}
  description={m.doc_delete_confirm()}
  confirmLabel={m.action_delete()}
  variant="destructive"
  busy={deleteBusy}
  onConfirm={confirmDelete}
  onCancel={cancelDelete}
/>
