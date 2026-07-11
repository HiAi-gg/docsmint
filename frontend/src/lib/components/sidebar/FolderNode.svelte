<!-- FolderNode.svelte — Recursive folder rendering for the sidebar tree.

     A folder can contain documents and other folders. Subfolders are
     rendered as nested <FolderNode> instances, so arbitrarily deep
     folder trees work without recursion depth issues.

     Responsibilities:
       - Render the folder header (chevron, name, more-options menu).
       - On first expand, lazily fetch the folder's subfolders via
         `getFolder(folder.id)` (the sidebar lists only return top-level
         folders via `listFolders(null)`; `getFolder(id)` returns the
         immediate children).
       - Expose two dndzones inside the expanded body:
           - `type: "doc"`   — re-files documents into / out of the folder.
           - `type: "folder"` — nests folders under this folder (sets
             `parentId = folder.id`). The Uncategorized bucket uses
             `type: "folder"` for its dndzone too, so dropping a folder
             onto an empty bucket or onto another folder is the same drag
             gesture from the user's perspective.
       - Surface rename / delete actions through callbacks so the parent
         tree keeps ownership of the existing dialog state. -->

<script lang="ts">
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@hiai-gg/hiai-ui/components/ui/dropdown-menu";
import { ChevronRight, Folder, MoreVertical } from "lucide-svelte";
import type { Snippet } from "svelte";
import { flip } from "svelte/animate";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import type { Document } from "$lib/api/documents";
import { listFolders } from "$lib/api/folders";
import * as m from "$lib/paraglide/messages.js";
import {
	bumpSubfoldersRefresh,
	getSubfoldersRefresh,
	registerFolder,
} from "$lib/stores/subfolders-refresh-store.svelte.js";
import { cn } from "$lib/utils";
import { type DndEvent, dndzone } from "$lib/utils/dndzone";

export interface FolderNodeItem {
	id: string;
	name: string;
	categoryId?: string | null;
	parentId?: string | null;
	order?: number;
}

type FolderItem = FolderNodeItem;
type DndDoc = Document & { id: string };

let {
	folder,
	depth = 0,
	folderDocsMap,
	expandedFolderIds,
	isDraggingGlobal,
	isDraggingFolder = false,
	isDraggingDoc = false,
	dragDisabled,
	flipDurationMs,
	draggedDocId = null,
	onToggleFolder,
	onScheduleFolderExpand,
	onClearExpandTimer,
	onRename,
	onDelete,
	onShare,
	onConsiderDocs,
	onFinalizeDocs,
	onConsiderSubfolders,
	onFinalizeSubfolders,
	onDropOnFolder,
	docRowInner,
	copyButton,
	docMenu,
}: {
	folder: FolderItem;
	depth?: number;
	folderDocsMap: Record<string, DndDoc[]>;
	expandedFolderIds: Set<string>;
	isDraggingGlobal: boolean;
	isDraggingFolder?: boolean;
	isDraggingDoc?: boolean;
	dragDisabled: boolean;
	flipDurationMs: number;
	draggedDocId?: string | null;
	onToggleFolder: (id: string) => void;
	onScheduleFolderExpand: (id: string) => void;
	onClearExpandTimer: () => void;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string, name: string) => void;
	onShare: (id: string, name: string) => void;
	onConsiderDocs: (zone: {
		kind: "folder";
		id: string;
	}) => (e: CustomEvent<DndEvent<DndDoc>>) => void;
	onFinalizeDocs: (zone: {
		kind: "folder";
		id: string;
	}) => (e: CustomEvent<DndEvent<DndDoc>>) => void;
	onConsiderSubfolders: (
		parentId: string,
	) => (e: CustomEvent<DndEvent<FolderItem>>) => void;
	onFinalizeSubfolders: (
		parentId: string,
	) => (e: CustomEvent<DndEvent<FolderItem>>) => void;
	onDropOnFolder: (e: DragEvent, folderId: string) => void;
	docRowInner: Snippet<[DndDoc]>;
	copyButton: Snippet<[DndDoc]>;
	docMenu: Snippet<[DndDoc]>;
} = $props();

// Subfolders for this folder. Empty until the user expands the node
// for the first time. The parent owns the top-level folder list;
// once a subfolder is loaded we keep it locally so re-collapse does
// not force a refetch.
let subfolders = $state<FolderItem[]>([]);
let subfoldersLoaded = $state(false);
let subfoldersLoading = $state(false);
let subfoldersError = $state<string | null>(null);

// Local working copy of the subfolder dndzone (svelte-dnd-action
// mutates this during a drag).
let subfolderZone = $state<FolderItem[]>([]);

const isExpanded = $derived(expandedFolderIds.has(folder.id));
const folderDocs = $derived(folderDocsMap[folder.id] ?? []);

async function loadSubfolders() {
	subfoldersLoading = true;
	subfoldersError = null;
	try {
		// `listFolders(folder.id)` returns the immediate children of this
		// folder as a flat array — the same shape each child FolderNode
		// will recursively re-fetch. Using `getFolder(id)` would only
		// return the folder's own row (no children).
		const rows = await listFolders(folder.id);
		subfolders = rows.map((c) => {
			registerFolder(
				c.id,
				c.parentId ?? null,
				c.categoryId ?? null,
				c.order ?? 0,
			);
			return {
				id: c.id,
				name: c.name,
				categoryId: c.categoryId ?? null,
				parentId: c.parentId,
				order: c.order ?? 0,
			};
		});
		subfolderZone = subfolders;
		subfoldersLoaded = true;
	} catch (e) {
		console.error("FolderNode: failed to load subfolders", e);
		subfoldersError =
			e instanceof Error ? e.message : "Failed to load subfolders";
	} finally {
		subfoldersLoading = false;
	}
}

function handleExpandClick() {
	const wasExpanded = isExpanded;
	onToggleFolder(folder.id);
	if (!wasExpanded) {
		void loadSubfolders();
	}
}

// Re-fetch subfolders whenever the per-folder refresh nonce (held in
// `subfolders-refresh-store`) increments. FolderTree bumps the nonce
// for the source and destination folders after a successful
// nested-folder DnD persist so the moved folder immediately shows up
// in its new parent's list (or disappears from the old parent's list)
// without requiring a page reload.
//
// The store-backed approach works for recursively-nested FolderNode
// instances too — every level reads its own folder's nonce from the
// shared module state.
$effect(() => {
	const signal = getSubfoldersRefresh(folder.id);
	if (signal === 0) return;
	if (!subfoldersLoaded) return;
	void loadSubfolders();
});

function handleSubfolderConsiderProxy(e: CustomEvent<DndEvent<FolderItem>>) {
	e.stopPropagation();
	// Mirror the dragged state into our local working copy so the
	// subfolder list reorders during the drag. The parent persists
	// the move on finalize.
	subfolderZone = Array.isArray(e.detail.items)
		? (e.detail.items as FolderItem[])
		: [];
	onConsiderSubfolders(folder.id)(e);
}

function handleSubfolderFinalizeProxy(e: CustomEvent<DndEvent<FolderItem>>) {
	e.stopPropagation();
	subfolderZone = Array.isArray(e.detail.items)
		? (e.detail.items as FolderItem[])
		: [];
	onFinalizeSubfolders(folder.id)(e);
}
</script>

<div
	role="group"
	aria-label={folder.name}
	onmouseenter={() => {
		if (isDraggingGlobal && !isExpanded) onScheduleFolderExpand(folder.id);
	}}
	onmouseleave={() => {
		if (isDraggingGlobal) onClearExpandTimer();
	}}
>
	<div class="group/folder flex w-full min-w-0 items-center gap-1">
		<button
			type="button"
			onclick={handleExpandClick}
			ondragover={(e) => {
				if (draggedDocId) {
					e.preventDefault();
					if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				}
			}}
			ondrop={(e) => onDropOnFolder(e, folder.id)}
			aria-expanded={isExpanded}
			class={cn(
				"flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
				page.params.id === folder.id &&
					"bg-accent text-accent-foreground font-medium",
				draggedDocId && "hover:bg-accent/40 border border-dashed border-primary/30",
			)}
		>
			<ChevronRight
				class={cn(
					"size-3.5 shrink-0 transition-transform",
					isExpanded && "rotate-90",
				)}
			/>
			<Folder class="size-4 shrink-0 text-muted-foreground" />
			<span class="min-w-0 truncate">{folder.name}</span>
		</button>
		<DropdownMenu>
			<DropdownMenuTrigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/folder:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-label={m.editor_more_options()}
						title={m.editor_more_options()}
					>
						<MoreVertical class="size-3.5" />
					</button>
				{/snippet}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={() => goto("/folders/" + folder.id)}>
					{m.action_go_to()}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => goto(`/docs/new?folder=${folder.id}`)}>
					{m.dashboard_new_document()}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onShare(folder.id, folder.name)}>
					{m.doc_share()}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onRename(folder.id, folder.name)}>
					{m.folders_rename()}
				</DropdownMenuItem>
				<DropdownMenuItem
					class="text-destructive focus:text-destructive"
					onSelect={() => onDelete(folder.id, folder.name)}
				>
					{m.folders_delete()}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
	{#if isExpanded}
		<div class="ml-0.5 space-y-0.5 border-l border-border pl-0.5">
			<!-- Subfolders (recursive FolderNode). -->
			<div
				class={cn(
					"min-h-[8px] space-y-0.5 transition-all duration-150",
					isDraggingFolder && subfolderZone.length === 0 && "min-h-[36px] bg-accent/20 rounded border border-dashed border-muted-foreground/20"
				)}
				use:dndzone={{
					items: subfolderZone,
					flipDurationMs,
					type: "folder",
					dropTargetStyle: {},
					dragDisabled,
				}}
				onconsider={handleSubfolderConsiderProxy}
				onfinalize={handleSubfolderFinalizeProxy}
			>
				{#each subfolderZone as sub (sub.id)}
					{@const SubComponent = FolderNodeSelf}
					<div animate:flip={{ duration: flipDurationMs }}>
						<SubComponent
							folder={sub}
							depth={depth + 1}
							{folderDocsMap}
							{expandedFolderIds}
							{isDraggingGlobal}
							{isDraggingFolder}
							{isDraggingDoc}
							{dragDisabled}
							{flipDurationMs}
							{draggedDocId}
							{onToggleFolder}
							{onScheduleFolderExpand}
							{onClearExpandTimer}
							{onRename}
							{onShare}
							{onDelete}
							{onConsiderDocs}
							{onFinalizeDocs}
							{onConsiderSubfolders}
							{onFinalizeSubfolders}
							{onDropOnFolder}
							{docRowInner}
							{copyButton}
							{docMenu}
						/>
					</div>
				{/each}
				{#if subfoldersLoading}
					<p class="px-2 py-1 text-xs text-muted-foreground">Loading subfolders…</p>
				{/if}
				{#if subfoldersError}
					<p class="px-2 py-1 text-xs text-destructive">{subfoldersError}</p>
				{/if}
			</div>
			<!-- Documents. -->
			<div
				class={cn(
					"min-h-[8px] space-y-0.5 transition-all duration-150",
					isDraggingDoc && folderDocs.length === 0 && "min-h-[36px] bg-accent/20 rounded border border-dashed border-muted-foreground/20"
				)}
				use:dndzone={{
					items: folderDocs,
					flipDurationMs,
					type: "doc",
					dropTargetStyle: {},
					dragDisabled,
					useCursorForDetection: true,
					centreDraggedOnCursor: true,
				}}
				onconsider={onConsiderDocs({ kind: "folder", id: folder.id })}
				onfinalize={onFinalizeDocs({ kind: "folder", id: folder.id })}
			>
				{#each folderDocs as doc (doc.id)}
					<div
						animate:flip={{ duration: flipDurationMs }}
						class="group/doc flex w-full min-w-0 items-center gap-1"
					>
						{@render docRowInner(doc)}
						{@render copyButton(doc)}
						{@render docMenu(doc)}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<script module>
	// Svelte 5 components cannot reference themselves by name from
	// within their own template. Importing this module under a different
	// local binding at module scope and re-exporting it as `FolderNodeSelf`
	// gives the template a name it can resolve. The recursion happens at
	// instantiation time, not at compile time.
	import FolderNodeSelf from "./FolderNode.svelte";
	export { FolderNodeSelf };
</script>
