<script lang="ts">
import { Check, ChevronRight, Copy, FileText, Folder, Plus } from "lucide-svelte";
import { onMount } from "svelte";
import { flip } from "svelte/animate";
import { type DndEvent, dndzone } from "svelte-dnd-action";
import { page } from "$app/state";
import {
	type Document,
	listDocuments,
	updateDocument,
} from "$lib/api/documents";
import { createFolder, listFolders } from "$lib/api/folders";
import { Button } from "$lib/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as m from "$lib/paraglide/messages.js";
import { cn } from "$lib/utils";
import { copyToClipboard } from "$lib/utils/clipboard.js";

interface FolderItem {
	id: string;
	name: string;
}

type DndDoc = Document & { id: string };

const FLIP_MS = 200;
const FOLDER_EXPAND_DELAY_MS = 400;

let folders = $state<FolderItem[]>([]);
// Source of truth from the server. `rootItems` and `folderDocs` are the
// per-zone working copies that `svelte-dnd-action` mutates during a drag.
let documents = $state<DndDoc[]>([]);
let originalFolderByDoc = new Map<string, string | null>();
let expandedFolderIds = $state<Set<string>>(new Set());
let loadError = $state<string | null>(null);
let dragDisabled = $state(false);
// True while a drag is in flight across any zone. Folder auto-expand on
// hover should only fire during a drag, not on plain mouseover.
let isDraggingGlobal = $state(false);

let rootItems = $state<DndDoc[]>([]);
let folderDocsMap = $state<Record<string, DndDoc[]>>({});

let showNewFolderDialog = $state(false);
let newFolderName = $state("");
let newFolderError = $state<string | null>(null);
let newFolderSubmitting = $state(false);

let expandTimer: ReturnType<typeof setTimeout> | null = null;
let pendingExpandFolderId = $state<string | null>(null);

let copiedDocId = $state<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCopyLink(docId: string) {
	if (typeof window === "undefined") return;
	const url = `${window.location.origin}/docs/${docId}`;
	const ok = await copyToClipboard(url);
	if (!ok) return;
	copiedDocId = docId;
	if (copyTimer) clearTimeout(copyTimer);
	copyTimer = setTimeout(() => {
		copiedDocId = null;
		copyTimer = null;
	}, 2000);
}

function clearExpandTimer() {
	if (expandTimer !== null) {
		clearTimeout(expandTimer);
		expandTimer = null;
	}
	pendingExpandFolderId = null;
}

function scheduleFolderExpand(folderId: string) {
	clearExpandTimer();
	if (expandedFolderIds.has(folderId)) return;
	pendingExpandFolderId = folderId;
	expandTimer = setTimeout(() => {
		if (
			pendingExpandFolderId === folderId &&
			!expandedFolderIds.has(folderId)
		) {
			const next = new Set(expandedFolderIds);
			next.add(folderId);
			expandedFolderIds = next;
		}
		expandTimer = null;
		pendingExpandFolderId = null;
	}, FOLDER_EXPAND_DELAY_MS);
}

function sanitizeItems(raw: unknown): DndDoc[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(item): item is DndDoc =>
			item !== null &&
			typeof item === "object" &&
			typeof (item as { id?: unknown }).id === "string",
	) as DndDoc[];
}

function buildZoneState(docs: DndDoc[]): {
	root: DndDoc[];
	byFolder: Record<string, DndDoc[]>;
} {
	const root: DndDoc[] = [];
	const byFolder: Record<string, DndDoc[]> = {};
	for (const doc of docs) {
		if (doc.folderId) {
			const list = byFolder[doc.folderId] ?? [];
			list.push(doc);
			byFolder[doc.folderId] = list;
		} else {
			root.push(doc);
		}
	}
	return { root, byFolder };
}

function resyncZonesFromDocuments() {
	const { root, byFolder } = buildZoneState(documents);
	rootItems = root;
	folderDocsMap = byFolder;
}

async function loadFolders() {
	try {
		const result = await listFolders(null);
		folders = (result[0]?.children ?? []) as FolderItem[];
		loadError = null;
	} catch (e) {
		console.error("FolderTree: failed to load folders", e);
		loadError = "Failed to load folders";
	}
}

async function loadDocuments() {
	try {
		const res = await listDocuments({ limit: 100 });
		documents = res.items as DndDoc[];
		originalFolderByDoc = new Map(
			documents.map((d) => [d.id, d.folderId ?? null]),
		);
		resyncZonesFromDocuments();
	} catch (e) {
		console.error("FolderTree: failed to load documents", e);
		loadError = "Failed to load documents";
	}
}

async function refresh() {
	await Promise.all([loadFolders(), loadDocuments()]);
}

onMount(() => {
	void refresh();
});

function toggleFolder(id: string) {
	const wasExpanded = expandedFolderIds.has(id);
	const next = new Set(expandedFolderIds);
	if (wasExpanded) next.delete(id);
	else next.add(id);
	expandedFolderIds = next;

	// When collapsing mid-drag, temporarily disable dnd so svelte-dnd-action
	// does not try to measure zones that are about to be unmounted.
	dragDisabled = true;
	if (typeof window !== "undefined") {
		window.setTimeout(() => {
			dragDisabled = false;
		}, FLIP_MS + 50);
	}
}

function openNewFolderDialog() {
	showNewFolderDialog = true;
}

function closeNewFolderDialog() {
	showNewFolderDialog = false;
	newFolderName = "";
	newFolderError = null;
	newFolderSubmitting = false;
}

async function handleCreateFolder(e: Event) {
	e.preventDefault();
	newFolderError = null;

	const trimmed = newFolderName.trim();
	if (trimmed.length === 0) {
		newFolderError = "Name is required";
		return;
	}

	newFolderSubmitting = true;
	try {
		await createFolder({ name: trimmed, parentId: null });
		closeNewFolderDialog();
		await loadFolders();
	} catch (err) {
		console.error("FolderTree: createFolder failed", err);
		newFolderError = err instanceof Error ? err.message : m.error_generic();
	} finally {
		newFolderSubmitting = false;
	}
}

function setZoneItems(zoneFolderId: string | null, next: DndDoc[]) {
	if (zoneFolderId === null) {
		rootItems = next;
		return;
	}
	folderDocsMap = { ...folderDocsMap, [zoneFolderId]: next };
}

function handleConsider(zoneFolderId: string | null) {
	return (e: CustomEvent<DndEvent<DndDoc>>) => {
		isDraggingGlobal = true;
		const next = sanitizeItems(e.detail.items);
		setZoneItems(zoneFolderId, next);
		clearExpandTimer();
	};
}

function handleFinalize(zoneFolderId: string | null) {
	return (e: CustomEvent<DndEvent<DndDoc>>) => {
		const next = sanitizeItems(e.detail.items);
		setZoneItems(zoneFolderId, next);
		clearExpandTimer();
		void persistZoneChanges(zoneFolderId, next);
		isDraggingGlobal = false;
	};
}

async function persistZoneChanges(
	zoneFolderId: string | null,
	zoneItems: DndDoc[],
) {
	const target: string | null = zoneFolderId;
	const updates: Array<{ id: string; folderId: string | null }> = [];
	for (const item of zoneItems) {
		const original = originalFolderByDoc.get(item.id);
		if (original === undefined) continue;
		const current = item.folderId ?? null;
		if (current !== target || (target !== null && current !== target)) {
			updates.push({ id: item.id, folderId: target });
		}
	}
	if (updates.length === 0) return;
	try {
		await Promise.all(
			updates.map((u) => updateDocument(u.id, { folderId: u.folderId ?? undefined })),
		);
	} catch (err) {
		console.error("FolderTree: persist failed", err);
	} finally {
		await refresh();
	}
}
</script>

<div class="space-y-1">
  <h3 class="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{m.sidebar_folders()}</h3>
  {#if loadError}
    <p class="px-2 text-xs text-destructive">{loadError}</p>
  {/if}

  <div
    class="min-h-[8px] space-y-0.5"
    use:dndzone={{ items: rootItems, flipDurationMs: FLIP_MS, type: "doc", dropTargetStyle: {}, dragDisabled }}
    onconsider={handleConsider(null)}
    onfinalize={handleFinalize(null)}
  >
    {#each rootItems as doc (doc.id)}
      <div animate:flip={{ duration: FLIP_MS }} class="group/doc flex w-full min-w-0 items-center gap-1">
        <a
          href={`/docs/${doc.id}`}
          data-sveltekit-noscroll
          class={cn(
            "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
            page.params.id === doc.id && "bg-accent text-accent-foreground font-medium"
          )}
        >
          <span class="w-3.5 shrink-0"></span>
          <FileText class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 truncate">{doc.title}</span>
        </a>
        <button
          type="button"
          class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/doc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {copiedDocId === doc.id ? 'opacity-100' : ''}"
          aria-label={m.action_copy_link()}
          title={m.action_copy_link()}
          onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); void handleCopyLink(doc.id); }}
        >
          {#if copiedDocId === doc.id}
            <Check class="size-3.5" />
          {:else}
            <Copy class="size-3.5" />
          {/if}
        </button>
      </div>
    {/each}
  </div>

  {#each folders as folder (folder.id)}
    {@const isExpanded = expandedFolderIds.has(folder.id)}
    {@const folderDocs = folderDocsMap[folder.id] ?? []}
    <div
      role="group"
      aria-label={folder.name}
      onmouseenter={() => {
        if (isDraggingGlobal && !expandedFolderIds.has(folder.id))
          scheduleFolderExpand(folder.id);
      }}
      onmouseleave={() => {
        if (isDraggingGlobal) clearExpandTimer();
      }}
    >
      <button
        type="button"
        onclick={() => toggleFolder(folder.id)}
        aria-expanded={isExpanded}
        class={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
          page.params.id === folder.id && "bg-accent text-accent-foreground font-medium"
        )}
      >
        <ChevronRight class={cn("size-3.5 shrink-0 transition-transform", isExpanded && "rotate-90")} />
        <Folder class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 truncate">{folder.name}</span>
      </button>
      {#if isExpanded}
        <div class="ml-4 border-l border-border pl-1">
          <div
            class="min-h-[8px] space-y-0.5"
            use:dndzone={{ items: folderDocs, flipDurationMs: FLIP_MS, type: "doc", dropTargetStyle: {}, dragDisabled }}
            onconsider={handleConsider(folder.id)}
            onfinalize={handleFinalize(folder.id)}
          >
            {#each folderDocs as doc (doc.id)}
              <div animate:flip={{ duration: FLIP_MS }} class="group/doc flex w-full min-w-0 items-center gap-1">
                <a
                  href={`/docs/${doc.id}`}
                  data-sveltekit-noscroll
                  class={cn(
                    "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                    page.params.id === doc.id && "bg-accent text-accent-foreground font-medium"
                  )}
                >
                  <span class="w-3.5 shrink-0"></span>
                  <FileText class="size-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 truncate">{doc.title}</span>
                </a>
                <button
                  type="button"
                  class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/doc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {copiedDocId === doc.id ? 'opacity-100' : ''}"
                  aria-label={m.action_copy_link()}
                  title={m.action_copy_link()}
                  onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); void handleCopyLink(doc.id); }}
                >
                  {#if copiedDocId === doc.id}
                    <Check class="size-3.5" />
                  {:else}
                    <Copy class="size-3.5" />
                  {/if}
                </button>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/each}

  <button
    type="button"
    onclick={openNewFolderDialog}
    class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
  >
    <Plus class="size-3.5" />
    <span>{m.folders_new()}</span>
  </button>
</div>

<Dialog bind:open={showNewFolderDialog} onOpenChange={(next) => { if (!next) closeNewFolderDialog(); }}>
  <DialogHeader>
    <DialogTitle>{m.folders_new()}</DialogTitle>
    <DialogDescription>{m.folders_name_placeholder()}</DialogDescription>
  </DialogHeader>

  <form onsubmit={handleCreateFolder} class="space-y-4">
    <div class="space-y-2">
      <Label for="new-folder-name">{m.folders_name_placeholder()}</Label>
      <Input
        id="new-folder-name"
        name="name"
        type="text"
        bind:value={newFolderName}
        placeholder={m.folders_name_placeholder()}
        maxlength={50}
        required
        disabled={newFolderSubmitting}
        aria-invalid={newFolderError ? "true" : undefined}
        aria-describedby={newFolderError ? "new-folder-name-error" : undefined}
        autocomplete="off"
      />
      {#if newFolderError}
        <p id="new-folder-name-error" class="text-xs text-destructive" role="alert">{newFolderError}</p>
      {/if}
    </div>
  </form>

  <DialogFooter>
    <Button
      variant="outline"
      type="button"
      onclick={closeNewFolderDialog}
      disabled={newFolderSubmitting}
    >
      {m.action_cancel()}
    </Button>
    <Button
      type="submit"
      onclick={handleCreateFolder}
      disabled={newFolderSubmitting || newFolderName.trim().length === 0}
    >
      {newFolderSubmitting ? m.action_loading() : m.action_create()}
    </Button>
  </DialogFooter>
</Dialog>
