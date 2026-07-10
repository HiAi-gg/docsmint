<!-- FolderTree.svelte — Sidebar tree of documents grouped by category.
     Hierarchy:
       Documents
         Category A (expandable)
           Folder X (expandable, with drag-and-drop docs)
             Doc 1
             Doc 2
           Folder Y
         Category B
           Folder Z
         Uncategorized (always shown)
           Folder W (no category)
           Root-level docs (no folder, no category)

     The dnd zone that used to be the implicit "root" still exists at the
     top of the Uncategorized group so users can drag documents out of a
     folder to detach them. -->
<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import { ConfirmDialog } from "@hiai-gg/hiai-ui/components/ui/confirm-dialog";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@hiai-gg/hiai-ui/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@hiai-gg/hiai-ui/components/ui/dropdown-menu";
import { Input } from "@hiai-gg/hiai-ui/components/ui/input";
import { Label } from "@hiai-gg/hiai-ui/components/ui/label";
import {
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	FileText,
	Folder,
	Loader2,
	MoreVertical,
	Pencil,
	Plus,
	Share2,
	Trash2,
} from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import { flip } from "svelte/animate";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import {
	type Category,
	deleteCategory,
	listCategories,
	updateCategory,
} from "$lib/api/categories";
import { apiFetch } from "$lib/api/client";
import {
	clearDocumentsCache,
	type Document,
	deleteDocument,
	getDocument,
	listDocuments,
	updateDocument,
} from "$lib/api/documents";
import {
	createFolder,
	deleteFolder,
	listFolders,
	updateFolder,
} from "$lib/api/folders";
import ShareDialog from "$lib/components/ShareDialog.svelte";
import CategoryDialog from "$lib/components/sidebar/CategoryDialog.svelte";
import FolderNode from "$lib/components/sidebar/FolderNode.svelte";
import * as m from "$lib/paraglide/messages.js";
import {
	bumpSubfoldersRefresh,
	getDocumentFromRegistry,
	getFolderFromRegistry,
	getGlobalFolderRefreshNonce,
	registerDocument,
	registerFolder,
} from "$lib/stores/subfolders-refresh-store.svelte.js";
import {
	getDocRefreshNonce,
	getSelectedTag,
	refreshDocs,
} from "$lib/stores/tag-store.svelte";
import { cn } from "$lib/utils";
import { copyToClipboard } from "$lib/utils/clipboard.js";
import { type DndEvent, dndzone } from "$lib/utils/dndzone";

// Rename/delete target shared by folders and documents in the tree.
type EntityKind = "folder" | "doc";

// Top-level folder row shape. Subfolders are NOT preloaded; the
// recursive `FolderNode` component fetches them on expand via
// `getFolder(id)`. We keep only the fields we render or use to bucket
// folders into categories.
interface FolderItem {
	id: string;
	name: string;
	categoryId?: string | null;
	parentId?: string | null;
	order?: number;
}

type DndDoc = Document & { id: string };

/**
 * Identifies where a doc dndzone lives in the tree. Every doc zone
 * (folder content, category root-doc bucket, Uncategorized root)
 * carries one of these so the persist handler knows what to do with
 * a drop:
 *   - `{ kind: "folder", id }`   → drop inside folder `id`. The doc
 *     inherits the folder's `categoryId` (or `null` if the folder
 *     has none).
 *   - `{ kind: "category", id }` → drop on the category's root-doc
 *     bucket. The doc loses its `folderId` and gains `categoryId = id`.
 *   - `{ kind: "root" }`         → Uncategorized root zone. The doc
 *     is detached from any folder AND any category.
 */
type DocZone =
	| { kind: "folder"; id: string }
	| { kind: "category"; id: string }
	| { kind: "root" };

const FLIP_MS = 200;
const FOLDER_EXPAND_DELAY_MS = 400;
// Tiny initial-fetch delay so the sidebar lists don't fire their
// listDocuments calls at exactly the same instant on a cold page load
// — staggered delays here keep the burst under the documentRateLimiter
// threshold. RecentDocs mounts at 0ms, so we wait 500ms before kicking
// off the limit=100 fetch (the largest of the three concurrent list
// calls).
const INITIAL_FETCH_DELAY_MS = 500;

let folders = $state<FolderItem[]>([]);
type CategoryWithApiAccess = Category & {
	apiMode?: string | null;
	apiPermissionRead?: boolean | null;
	apiPermissionEdit?: boolean | null;
	apiPermissionWrite?: boolean | null;
};
let categories = $state<CategoryWithApiAccess[]>([]);
// Source of truth from the server. `rootItems` and `folderDocs` are the
// per-zone working copies that `svelte-dnd-action` mutates during a drag.
let documents = $state<DndDoc[]>([]);
let expandedFolderIds = $state<Set<string>>(new Set());
let expandedCategoryIds = $state<Set<string>>(new Set());
// "Uncategorized" group is expanded by default so users always see
// their unfiled root-level documents.
let uncategorizedExpanded = $state(true);
let loadError = $state<string | null>(null);
// Surfaces drag-and-drop persist failures so the UI keeps the optimistic
// move in place (we no longer call refresh() in the finally block) and
// the user can see something went wrong instead of watching the moved
// item silently jump back to its old category.
let dndError = $state<string | null>(null);
let dndErrorTimer: ReturnType<typeof setTimeout> | null = null;

function debugLog(...args: unknown[]) {
	if (import.meta.env.DEV) {
		console.log(...args);
	}
}

function setDndError(msg: string | null) {
	dndError = msg;
	if (dndErrorTimer) {
		clearTimeout(dndErrorTimer);
		dndErrorTimer = null;
	}
	if (msg !== null) {
		dndErrorTimer = setTimeout(() => {
			dndError = null;
			dndErrorTimer = null;
		}, 5000);
	}
}

let dragDisabled = $state(false);
// True while a drag is in flight across any zone. Folder auto-expand on
// hover should only fire during a drag, not on plain mouseover.
let isDraggingGlobal = $state(false);
let isDraggingFolder = $state(false);
let isDraggingDoc = $state(false);
let draggedDocId = $state<string | null>(null);
// Concurrency guard for `persistFolderChanges`. `svelte-dnd-action`
// dispatches `finalize` on BOTH source and destination zones for
// cross-zone drops; even though `handleFolderFinalize` already skips
// the source-zone persist, this flag is a defense-in-depth against any
// future call site (or a rapid successive drop) racing a still-running
// persist and clobbering the optimistic zone state with stale data.
let persistingFolders = $state(false);
let droppedOnHeader = false;

let rootItems = $state<DndDoc[]>([]);
let folderDocsMap = $state<Record<string, DndDoc[]>>({});
// Working copy for root-level docs bucketed by `categoryId`. Mirrors
// `rootItems` for the Uncategorized bucket but splits root docs by
// the category they belong to so each category bucket can host its
// own dndzone for re-filing root docs between categories.
let categoryRootDocsMap = $state<Record<string, DndDoc[]>>({});

// Working copies for the per-category folder DnD zones (`type: "folder"`).
// `svelte-dnd-action` mutates these during a drag; the canonical `folders`
// source is resynced in `resyncBucketFolders()` after a refresh.
// Keyed by categoryId (string) or the synthetic `UNCATEGORIZED_KEY` for the
// uncategorized bucket. Per-folder subfolder DnD is owned by each
// `FolderNode` instance (lazy-loaded via `getFolder(id)`).
let bucketFoldersMap = $state<Record<string, FolderItem[]>>({});

// Working copy for the category reorder dndzone (`type: "category"`).
// Always ends with the synthetic Uncategorized bucket so it can never
// disappear from the tree even if the user tries to drop the last
// category in its place.
//
// `id` (not `key`) is required: `svelte-dnd-action` validates every
// item in the `items` array and throws "missing 'id' property for
// item" otherwise. Both real category ids and the synthetic
// `UNCATEGORIZED_KEY` are valid ids here.
let orderedBuckets = $state<
	Array<{
		id: string;
		category: CategoryWithApiAccess | null;
		folders: FolderItem[];
	}>
>([]);

let showNewFolderDialog = $state(false);
let newFolderName = $state("");
let newFolderError = $state<string | null>(null);
let newFolderSubmitting = $state(false);

// Rename dialog state (shared by folders and documents).
let showRenameDialog = $state(false);
let renameTarget = $state<{
	kind: EntityKind;
	id: string;
	name: string;
} | null>(null);
let renameValue = $state("");
let renameError = $state<string | null>(null);
let renameSubmitting = $state(false);

// Delete confirmation state (shared by folders and documents).
let showDeleteDialog = $state(false);
let deleteTarget = $state<{
	kind: EntityKind;
	id: string;
	name: string;
} | null>(null);
let deleteBusy = $state(false);

let showShareDialog = $state(false);
let shareDocumentId = $state("");
let shareFolderId = $state("");
let shareDocumentTitle = $state("");
let shareFolderName = $state("");

// Category CRUD dialog state.
type CategoryDialogMode = "create" | "edit" | "delete";
let showCategoryDialog = $state(false);
let categoryDialogMode = $state<CategoryDialogMode>("create");
let selectedCategory = $state<CategoryWithApiAccess | null>(null);
let categoryBusy = $state(false);

let expandTimer: ReturnType<typeof setTimeout> | null = null;
let pendingExpandFolderId = $state<string | null>(null);

let categoryExpandTimer: ReturnType<typeof setTimeout> | null = null;
let pendingExpandCategoryId = $state<string | null>(null);

// (Per-folder subfolder refresh nonces are kept in a module-level
// reactive store — see `subfolders-refresh-store.svelte.ts` — so
// recursively-nested FolderNode instances can observe their own
// id's counter without prop-drilling.)

let copiedDocId = $state<string | null>(null);
let copyLoadingDocId = $state<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCopyContent(docId: string) {
	if (typeof window === "undefined") return;
	// Copy the document's full markdown source. The list endpoint returns
	// `content` truncated to 200 chars at the SQL level, so we fetch the
	// single-document endpoint first to get the complete text. If the
	// fetch fails we fall back to the list payload (excerpt, then
	// truncated content) so the button still does something.
	const cached = documents.find((d) => d.id === docId);
	let text = "";
	copyLoadingDocId = docId;
	try {
		const full = await getDocument(docId);
		text = full.content ?? "";
	} catch (err) {
		console.error("FolderTree: failed to fetch full document for copy", err);
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

function clearCategoryExpandTimer() {
	if (categoryExpandTimer !== null) {
		clearTimeout(categoryExpandTimer);
		categoryExpandTimer = null;
	}
	pendingExpandCategoryId = null;
}

function scheduleCategoryExpand(categoryId: string) {
	clearCategoryExpandTimer();
	const isExpanded =
		categoryId === UNCATEGORIZED_KEY
			? uncategorizedExpanded
			: expandedCategoryIds.has(categoryId);
	if (isExpanded) return;
	pendingExpandCategoryId = categoryId;
	categoryExpandTimer = setTimeout(() => {
		if (pendingExpandCategoryId === categoryId) {
			if (categoryId === UNCATEGORIZED_KEY) {
				uncategorizedExpanded = true;
			} else {
				const next = new Set(expandedCategoryIds);
				next.add(categoryId);
				expandedCategoryIds = next;
			}
		}
		categoryExpandTimer = null;
		pendingExpandCategoryId = null;
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
	/**
	 * Root docs that have no category either — i.e. fully unfiled.
	 * These render in the Uncategorized bucket's root dndzone.
	 */
	root: DndDoc[];
	/**
	 * Root docs bucketed by `categoryId`. A doc with `folderId: null`
	 * and `categoryId: <cat>` lands here so the user can drag it to
	 * another category or to Uncategorized (which sets `categoryId`
	 * back to null).
	 */
	byCategory: Record<string, DndDoc[]>;
	/** Docs that live inside a folder. Keyed by folderId. */
	byFolder: Record<string, DndDoc[]>;
} {
	const root: DndDoc[] = [];
	const byCategory: Record<string, DndDoc[]> = {};
	const byFolder: Record<string, DndDoc[]> = {};
	for (const doc of docs) {
		if (doc.folderId) {
			const list = byFolder[doc.folderId] ?? [];
			list.push(doc);
			byFolder[doc.folderId] = list;
		} else if (doc.categoryId) {
			const list = byCategory[doc.categoryId] ?? [];
			list.push(doc);
			byCategory[doc.categoryId] = list;
		} else {
			root.push(doc);
		}
	}
	return { root, byCategory, byFolder };
}

function resyncZonesFromDocuments() {
	const { root, byCategory, byFolder } = buildZoneState(documents);
	rootItems = root;
	categoryRootDocsMap = byCategory;
	folderDocsMap = byFolder;
}

// Bucket folders by their categoryId (or `UNCATEGORIZED_KEY` for folders
// without a category). Mirrors the layout of the `buckets` derived below
// but as a mutable working copy for `svelte-dnd-action`.
function resyncBucketFolders() {
	const byCategory = new Map<string, FolderItem[]>();
	for (const cat of categories) byCategory.set(cat.id, []);
	const uncategorized: FolderItem[] = [];
	for (const folder of folders) {
		if (folder.categoryId && byCategory.has(folder.categoryId)) {
			byCategory.get(folder.categoryId)?.push(folder);
		} else {
			uncategorized.push(folder);
		}
	}
	const next: Record<string, FolderItem[]> = {};
	for (const cat of categories) {
		next[cat.id] = byCategory.get(cat.id) ?? [];
	}
	next[UNCATEGORIZED_KEY] = uncategorized;
	bucketFoldersMap = next;
}

// Mirror the `buckets` derived into `orderedBuckets` whenever it changes
// (refresh, new category, etc.). During an in-flight drag the dndzone
// mutates `orderedBuckets` directly; on finalize we persist the new
// order and resync from the server.
$effect(() => {
	// Touch `folders`/`categories` so the effect re-runs when they change.
	void folders;
	void categories;
	orderedBuckets = buckets.map((b) => ({
		id: b.id,
		category: b.category,
		folders: b.folders,
	}));
	resyncBucketFolders();
});

async function loadFolders() {
	try {
		const result = await listFolders(null);
		// `result` is `[syntheticRoot]` whose `children` are the top-level
		// folders. The `toFolder` mapper preserves `categoryId` so we can
		// group by category here without an extra round-trip. Subfolders
		// are NOT loaded here — they are fetched lazily by the recursive
		// `FolderNode` component on first expand via `getFolder(id)`.
		folders = (result[0]?.children ?? []).map((f) => {
			registerFolder(
				f.id,
				f.parentId ?? null,
				f.categoryId ?? null,
				f.order ?? 0,
			);
			return {
				id: f.id,
				name: f.name,
				categoryId: f.categoryId ?? null,
				parentId: f.parentId,
				order: f.order ?? 0,
			};
		});
		loadError = null;
	} catch (e) {
		console.error("FolderTree: failed to load folders", e);
		loadError = "Failed to load folders";
	}
}

async function loadCategories() {
	try {
		categories = (await listCategories()) as CategoryWithApiAccess[];
	} catch (e) {
		// Don't surface category-load failures as a hard error — the
		// folder tree must still render even if the categories endpoint
		// is briefly unavailable. Uncategorized is a safe fallback.
		console.error("FolderTree: failed to load categories", e);
	}
}

async function loadDocuments() {
	try {
		const tag = getSelectedTag();
		const res = await listDocuments({ limit: 100, ...(tag ? { tag } : {}) });
		documents = res.items as DndDoc[];
		documents.forEach((d) => {
			debugLog(
				"[DnD] loadDocuments registering doc:",
				d.id,
				"title:",
				d.title,
				"categoryId:",
				d.categoryId,
				"folderId:",
				d.folderId,
				"rawDocKeys:",
				Object.keys(d),
			);
			registerDocument(d.id, d.folderId ?? null, d.categoryId ?? null);
		});
		resyncZonesFromDocuments();
	} catch (e) {
		console.error("FolderTree: failed to load documents", e);
		loadError = "Failed to load documents";
	}
}

async function refresh() {
	clearDocumentsCache();
	await Promise.all([loadFolders(), loadCategories(), loadDocuments()]);
}

onMount(() => {
	if (INITIAL_FETCH_DELAY_MS <= 0) {
		void refresh();
		return;
	}
	const timer = setTimeout(() => {
		void refresh();
	}, INITIAL_FETCH_DELAY_MS);
	return () => clearTimeout(timer);
});

onDestroy(() => {
	// Clear the pending dnd-error auto-dismiss timer so we don't write
	// to a destroyed component's state if the user navigates away
	// mid-delay.
	if (dndErrorTimer) {
		clearTimeout(dndErrorTimer);
		dndErrorTimer = null;
	}
	if (expandTimer) {
		clearTimeout(expandTimer);
		expandTimer = null;
	}
	if (categoryExpandTimer) {
		clearTimeout(categoryExpandTimer);
		categoryExpandTimer = null;
	}
});

$effect(() => {
	const docNonce = getDocRefreshNonce();
	const folderNonce = getGlobalFolderRefreshNonce();
	if (docNonce === 0 && folderNonce === 0) return;
	void refresh();
});

let firstTagRun = true;
$effect(() => {
	const tag = getSelectedTag();
	if (firstTagRun) {
		firstTagRun = false;
		return;
	}
	void refresh();
});

// Note: a previous `$effect` here watched `getDocRefreshNonce()` and
// `getSelectedTag()` to refetch the tree on every refresh/tag change.
// It caused the sidebar to fire listDocuments calls on EVERY reactive
// dependency change — which combined with the other sidebar components
// burst past the documentRateLimiter and triggered 429s on cold loads.
//
// We now refresh only:
//   - once on mount (above)
//   - after local rename/delete/drag-persist handlers (which already call refresh)
//   - when the explicit `refreshFolderTree()` helper below is invoked from
//     outside (e.g. by the dashboard after import).
//
// Cross-component invalidation flows through `refreshDocs()` (the nonce
// store), but consumers should call `refreshFolderTree()` directly when
// they need an immediate reload rather than relying on a shared $effect.

/**
 * Public reload entry point. Exposed so other components (dashboard
 * after import, RecentDocs after rename/delete, etc.) can request an
 * immediate refresh without going through the shared nonce store —
 * keeps the burst of initial fetches under control.
 */
export async function refreshFolderTree(): Promise<void> {
	await refresh();
}

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

function toggleCategory(id: string) {
	const next = new Set(expandedCategoryIds);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expandedCategoryIds = next;
}

function toggleUncategorized() {
	uncategorizedExpanded = !uncategorizedExpanded;
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

function setZoneItems(zone: DocZone, next: DndDoc[]) {
	if (zone.kind === "root") {
		rootItems = next;
		return;
	}
	if (zone.kind === "category") {
		categoryRootDocsMap = { ...categoryRootDocsMap, [zone.id]: next };
		return;
	}
	folderDocsMap = { ...folderDocsMap, [zone.id]: next };
}

function handleConsider(zone: DocZone) {
	return (e: CustomEvent<DndEvent<DndDoc>>) => {
		e.stopPropagation();
		isDraggingGlobal = true;
		isDraggingDoc = true;
		if (e.detail.info?.id) {
			draggedDocId = e.detail.info.id;
		}
		const next = sanitizeItems(e.detail.items);
		setZoneItems(zone, next);
		clearExpandTimer();
	};
}

function handleFinalize(zone: DocZone) {
	return (e: CustomEvent<DndEvent<DndDoc>>) => {
		e.stopPropagation();
		const next = sanitizeItems(e.detail.items);
		setZoneItems(zone, next);
		clearExpandTimer();
		const isSourceZone = e.detail.info?.trigger === "droppedIntoAnother";
		debugLog(
			"[DnD] handleFinalize zone:",
			zone,
			"trigger:",
			e.detail.info?.trigger,
			"isSourceZone:",
			isSourceZone,
			"droppedOnHeader:",
			droppedOnHeader,
		);
		if (!isSourceZone) {
			if (droppedOnHeader) {
				debugLog(
					"[DnD] Skipping persistZoneChanges because droppedOnHeader is true",
				);
				droppedOnHeader = false;
			} else {
				void persistZoneChanges(zone, next);
			}
		}
		isDraggingGlobal = false;
		isDraggingDoc = false;
		draggedDocId = null;
	};
}

async function persistZoneChanges(zone: DocZone, zoneItems: DndDoc[]) {
	const targetFolderId: string | null = zone.kind === "folder" ? zone.id : null;
	const targetCategoryId: string | null =
		zone.kind === "category"
			? zone.id
			: zone.kind === "root"
				? null
				: // Resolve nested folder category ID using the registry
					(getFolderFromRegistry(zone.id)?.categoryId ?? null);
	debugLog(
		"[DnD] persistZoneChanges zone:",
		zone,
		"targetFolderId:",
		targetFolderId,
		"targetCategoryId:",
		targetCategoryId,
	);
	const updates: Array<{
		id: string;
		folderId?: string | null;
		categoryId?: string | null;
	}> = [];
	for (const item of zoneItems) {
		const original = getDocumentFromRegistry(item.id);
		if (!original) {
			debugLog("[DnD] Item not found in registry:", item.id);
			continue;
		}

		const originalFolder = original.folderId;
		const originalCategory = original.categoryId;
		const folderChanged = originalFolder !== targetFolderId;
		const categoryChanged = originalCategory !== targetCategoryId;
		debugLog(
			"[DnD] Checking item:",
			item.id,
			"originalFolder:",
			originalFolder,
			"targetFolderId:",
			targetFolderId,
			"originalCategory:",
			originalCategory,
			"targetCategoryId:",
			targetCategoryId,
			"folderChanged:",
			folderChanged,
			"categoryChanged:",
			categoryChanged,
		);
		if (folderChanged || categoryChanged) {
			updates.push({
				id: item.id,
				folderId: targetFolderId,
				categoryId: targetCategoryId,
			});
			// Update client-side registry immediately to prevent duplicate runs
			registerDocument(item.id, targetFolderId, targetCategoryId);
		}
	}
	if (updates.length === 0) {
		debugLog("[DnD] No updates to persist for zone:", zone);
		return;
	}
	debugLog("[DnD] persistZoneChanges updates:", updates);
	try {
		const results = await Promise.all(
			updates.map((u) =>
				updateDocument(u.id, {
					folderId: u.folderId,
					categoryId: u.categoryId,
				}),
			),
		);
		debugLog("[DnD] updateDocument results:", results);
		// Only re-sync from the server when the backend confirmed the move.
		// On failure we deliberately keep the optimistic zone state so the
		// user's drop is not silently reverted.
		await refresh();
	} catch (err) {
		console.error("FolderTree: persist failed", err);
		setDndError(
			err instanceof Error
				? `Move failed: ${err.message}`
				: "Move failed: unknown error",
		);
	}
}

function handleDragOver(e: DragEvent) {
	if (draggedDocId) {
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = "move";
		}
	}
}

async function handleDropOnCategory(e: DragEvent, categoryId: string) {
	if (!draggedDocId) return;
	droppedOnHeader = true;
	e.preventDefault();
	e.stopPropagation();

	const targetCategoryId = categoryId === UNCATEGORIZED_KEY ? null : categoryId;
	const original = getDocumentFromRegistry(draggedDocId);
	if (!original) return;

	const folderChanged = original.folderId !== null;
	const categoryChanged = original.categoryId !== targetCategoryId;

	if (folderChanged || categoryChanged) {
		registerDocument(draggedDocId, null, targetCategoryId);
		documents = documents.map((d) =>
			d.id === draggedDocId
				? { ...d, folderId: null, categoryId: targetCategoryId }
				: d,
		);
		resyncZonesFromDocuments();

		try {
			debugLog(
				"[DnD] Drop on category header:",
				categoryId,
				"doc:",
				draggedDocId,
			);
			await updateDocument(draggedDocId, {
				folderId: null,
				categoryId: targetCategoryId,
			});
			await refresh();
		} catch (err) {
			console.error("Failed to move document to category header", err);
			setDndError(err instanceof Error ? err.message : "Move failed");
		}
	}
	draggedDocId = null;
}

async function handleDropOnFolder(e: DragEvent, folderId: string) {
	if (!draggedDocId) return;
	droppedOnHeader = true;
	e.preventDefault();
	e.stopPropagation();

	const targetFolder = getFolderFromRegistry(folderId);
	const targetCategoryId = targetFolder?.categoryId ?? null;
	const original = getDocumentFromRegistry(draggedDocId);
	if (!original) return;

	const folderChanged = original.folderId !== folderId;

	if (folderChanged) {
		registerDocument(draggedDocId, folderId, targetCategoryId);
		documents = documents.map((d) =>
			d.id === draggedDocId
				? { ...d, folderId: folderId, categoryId: targetCategoryId }
				: d,
		);
		resyncZonesFromDocuments();

		try {
			debugLog("[DnD] Drop on folder header:", folderId, "doc:", draggedDocId);
			await updateDocument(draggedDocId, {
				folderId: folderId,
				categoryId: targetCategoryId,
			});
			await refresh();
			bumpSubfoldersRefresh(folderId);
			if (original.folderId) {
				bumpSubfoldersRefresh(original.folderId);
			}
		} catch (err) {
			console.error("Failed to move document to folder header", err);
			setDndError(err instanceof Error ? err.message : "Move failed");
		}
	}
	draggedDocId = null;
}

// --- Folder DnD between categories (`type: "folder"`) ---
//
// Each category bucket hosts its own dndzone of folders. `handleFolderConsider`
// mirrors the dragged state into `bucketFoldersMap`; `handleFolderFinalize`
// persists any category moves or order changes via `updateFolder`. The
// same `type: "folder"` is reused inside `FolderNode` for nesting
// (parentId updates), and the per-folder zone key is `parent:<id>` so
// `persistFolderChanges` can distinguish the two operations.
const PARENT_ZONE_PREFIX = "parent:";

function handleFolderConsider(zoneKey: string) {
	return (e: CustomEvent<DndEvent<FolderItem>>) => {
		e.stopPropagation();
		isDraggingGlobal = true;
		isDraggingFolder = true;
		const next = sanitizeFolderItems(e.detail.items);
		// `bucketFoldersMap` is the source for category buckets; per-folder
		// nested subfolders live inside each `FolderNode` and don't share
		// state with this map. Both call this handler though — only the
		// category-bucket variant (zoneKey not starting with `parent:`)
		// needs to mutate `bucketFoldersMap` here.
		if (!zoneKey.startsWith(PARENT_ZONE_PREFIX)) {
			bucketFoldersMap = { ...bucketFoldersMap, [zoneKey]: next };
		}
	};
}

function handleFolderFinalize(zoneKey: string) {
	return (e: CustomEvent<DndEvent<FolderItem>>) => {
		e.stopPropagation();
		const next = sanitizeFolderItems(e.detail.items);
		const isSourceZone = e.detail.info?.trigger === "droppedIntoAnother";

		if (!zoneKey.startsWith(PARENT_ZONE_PREFIX)) {
			// Update bucketFoldersMap for both zones to keep Svelte state in sync with svelte-dnd-action
			bucketFoldersMap = { ...bucketFoldersMap, [zoneKey]: next };
		}
		isDraggingGlobal = false;
		isDraggingFolder = false;

		// Only persist changes for the DESTINATION zone.
		// The source zone's persist would send stale data and race with
		// the destination zone's correct persist.
		if (!isSourceZone) {
			void persistFolderChanges(zoneKey, next);
		}
	};
}

// Wrappers used by FolderNode's per-folder subfolder zones. Each
// FolderNode renders a `type: "folder"` zone keyed by `parent:<id>`
// so persistFolderChanges can detect nesting moves and update
// `parentId` instead of `categoryId`.
function handleNestedFolderConsider(parentId: string) {
	return handleFolderConsider(`${PARENT_ZONE_PREFIX}${parentId}`);
}

function handleNestedFolderFinalize(parentId: string) {
	return handleFolderFinalize(`${PARENT_ZONE_PREFIX}${parentId}`);
}

function sanitizeFolderItems(raw: unknown): FolderItem[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(item): item is FolderItem =>
			item !== null &&
			typeof item === "object" &&
			typeof (item as { id?: unknown }).id === "string",
	) as FolderItem[];
}

// Compute the set of folder ids that would form a cycle if `targetParentId`
// became their parent. Includes `targetParentId` itself, plus every folder
// (transitively) whose `parentId` chain leads back to it. Used by the
// parent-zone persist path to refuse invalid drops before they round-trip
// to the backend.
function computeBlockedAncestors(
	all: FolderItem[],
	targetParentId: string | null,
): Set<string> {
	const blocked = new Set<string>();
	if (!targetParentId) return blocked;
	blocked.add(targetParentId);
	// Walk the flat list until the blocked set stops growing — bounded
	// by the number of folders the user actually owns.
	let changed = true;
	while (changed) {
		changed = false;
		for (const f of all) {
			const pid = f.parentId ?? null;
			if (pid && blocked.has(pid) && !blocked.has(f.id)) {
				blocked.add(f.id);
				changed = true;
			}
		}
	}
	return blocked;
}

async function persistFolderChanges(zoneKey: string, zoneItems: FolderItem[]) {
	const isParentZone = zoneKey.startsWith(PARENT_ZONE_PREFIX);
	const targetCategoryId: string | null = isParentZone
		? null
		: zoneKey === UNCATEGORIZED_KEY
			? null
			: zoneKey;
	const targetParentId: string | null = isParentZone
		? zoneKey.slice(PARENT_ZONE_PREFIX.length) || null
		: null;

	// Each update stores the PATCH payload (no `id` in body — matches
	// the working document DnD pattern in `persistZoneChanges`).
	const updatesMap = new Map<
		string,
		{
			folderId: string;
			categoryId?: string | null;
			parentId?: string | null;
			order?: number;
		}
	>();

	const blocked: Set<string> = isParentZone
		? computeBlockedAncestors(folders, targetParentId)
		: new Set();

	if (isParentZone) {
		for (const folder of zoneItems) {
			if (blocked.has(folder.id)) continue;
			const original = getFolderFromRegistry(folder.id);
			if (!original) continue;

			if (original.parentId !== targetParentId) {
				updatesMap.set(folder.id, {
					folderId: folder.id,
					parentId: targetParentId,
				});
				// Update client-side registry immediately so a second
				// concurrent call (from the source zone) finds no diff.
				registerFolder(
					folder.id,
					targetParentId,
					original.categoryId,
					original.order,
				);
			}
		}
	} else {
		for (const folder of zoneItems) {
			const original = getFolderFromRegistry(folder.id);
			if (!original) continue;

			const categoryChanged = original.categoryId !== targetCategoryId;
			const parentChanged = original.parentId !== null;

			if (categoryChanged || parentChanged) {
				const payload: typeof updatesMap extends Map<string, infer V>
					? V
					: never = {
					folderId: folder.id,
				};
				// Only include fields that actually changed
				if (categoryChanged) payload.categoryId = targetCategoryId;
				if (parentChanged) payload.parentId = null;
				updatesMap.set(folder.id, payload);
				registerFolder(folder.id, null, targetCategoryId, original.order);
			}
		}
	}

	// Compute per-zone order for the items that landed in `zoneKey`. We
	// assign sequential orders starting at 0 so the backend's
	// `order, name` sort reflects the user's new order. For parent zones
	// we skip folders that are blocked from nesting. Only add to updates
	// if the order actually changed.
	zoneItems.forEach((folder, index) => {
		if (isParentZone && blocked.has(folder.id)) return;
		const original = getFolderFromRegistry(folder.id);
		if (!original) return;

		const orderChanged = original.order !== index;
		const existingUpdate = updatesMap.get(folder.id);
		if (existingUpdate) {
			existingUpdate.order = index;
			registerFolder(
				folder.id,
				existingUpdate.parentId !== undefined
					? existingUpdate.parentId
					: original.parentId,
				existingUpdate.categoryId !== undefined
					? existingUpdate.categoryId
					: original.categoryId,
				index,
			);
		} else if (orderChanged) {
			updatesMap.set(folder.id, { folderId: folder.id, order: index });
			registerFolder(folder.id, original.parentId, original.categoryId, index);
		}
	});

	const updates = Array.from(updatesMap.values());

	// For nested-folder DnD, track every folder whose subfolder list
	// changed (the source parent lost a child; the destination parent
	// gained one). We bump those folders' refresh signals after
	// `refresh()` so each affected `FolderNode` refetches its children
	// and the moved folder shows up in its new location immediately.
	const affectedParents = new Set<string>();
	if (isParentZone) {
		if (targetParentId) affectedParents.add(targetParentId);
		for (const folder of zoneItems) {
			const originalParent = folder.parentId ?? null;
			if (originalParent !== null && originalParent !== targetParentId) {
				affectedParents.add(originalParent);
			}
		}
	}

	if (updates.length === 0) {
		debugLog("[DnD] persistFolderChanges: no changes for zone", zoneKey);
		return;
	}
	debugLog("[DnD] persistFolderChanges zone:", zoneKey, "updates:", updates);
	try {
		// Send clean payloads without folderId in body (same pattern as
		// document DnD `persistZoneChanges` which is confirmed working).
		const results = await Promise.all(
			updates.map((u) => {
				const { folderId, ...patchBody } = u;
				return updateFolder(folderId, patchBody);
			}),
		);
		debugLog("[DnD] updateFolder results:", results);
		// Re-sync from the server after the backend confirmed the move.
		await refresh();
		// Rebuild the per-category folder buckets from the refreshed
		// `folders` array.
		resyncBucketFolders();
		// Bump the refresh signals for any folder whose subfolder list
		// changed during this persist.
		for (const folderId of affectedParents) {
			bumpSubfoldersRefresh(folderId);
		}
	} catch (err) {
		console.error("FolderTree: folder DnD persist failed", err);
		setDndError(
			err instanceof Error
				? `Move failed: ${err.message}`
				: "Move failed: unknown error",
		);
	}
}

// --- Category reorder DnD (`type: "category"`) ---
//
// The category header row is a single dndzone whose items are the
// `buckets` array. On finalize we reassign sequential `order` values
// to each (non-Uncategorized) category and persist via `updateCategory`.
// The Uncategorized bucket is always pinned at the end and is not
// draggable.
type CategoryBucket = {
	id: string;
	category: CategoryWithApiAccess | null;
	folders: FolderItem[];
};

function handleCategoryConsider(e: CustomEvent<DndEvent<CategoryBucket>>) {
	e.stopPropagation();
	isDraggingGlobal = true;
	orderedBuckets = sanitizeBuckets(e.detail.items);
}

function handleCategoryFinalize(e: CustomEvent<DndEvent<CategoryBucket>>) {
	e.stopPropagation();
	const next = sanitizeBuckets(e.detail.items);
	orderedBuckets = next;
	isDraggingGlobal = false;
	void persistCategoryOrder(next);
}

function sanitizeBuckets(raw: unknown): CategoryBucket[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(item): item is CategoryBucket =>
				item !== null &&
				typeof item === "object" &&
				typeof (item as { id?: unknown }).id === "string",
		)
		.map((b) => ({ id: b.id, category: b.category, folders: b.folders }));
}

async function persistCategoryOrder(next: CategoryBucket[]) {
	// Only categories (non-Uncategorized, non-null) need an order update.
	const updates: Array<{ id: string; order: number }> = [];
	next.forEach((bucket, index) => {
		if (!bucket.category) return;
		updates.push({ id: bucket.category.id, order: index });
	});
	if (updates.length === 0) return;
	try {
		await Promise.all(
			updates.map((u) => updateCategory(u.id, { order: u.order })),
		);
	} catch (err) {
		console.error("FolderTree: category DnD persist failed", err);
	} finally {
		await refresh();
		// Keep the per-category folder buckets in sync with the freshly
		// reordered category list (same reasoning as in
		// `persistFolderChanges`).
		resyncBucketFolders();
	}
}

// --- Rename / delete (folders and documents) ---
function startRename(kind: EntityKind, id: string, name: string) {
	renameTarget = { kind, id, name };
	renameValue = name;
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
		if (target.kind === "folder") {
			await updateFolder(target.id, { name: trimmed });
		} else {
			await updateDocument(target.id, { title: trimmed });
		}
		closeRenameDialog();
		await refresh();
		// Notify the other sidebar lists (RecentDocs) to refetch.
		refreshDocs();
	} catch (err) {
		console.error("FolderTree: rename failed", err);
		renameError = err instanceof Error ? err.message : m.error_generic();
	} finally {
		renameSubmitting = false;
	}
}

function startDelete(kind: EntityKind, id: string, name: string) {
	deleteTarget = { kind, id, name };
	showDeleteDialog = true;
}

function openShareDialogForDocument(id: string, title: string) {
	shareDocumentId = id;
	shareFolderId = "";
	shareDocumentTitle = title;
	shareFolderName = "";
	showShareDialog = true;
}

function openShareDialogForFolder(id: string, name: string) {
	shareFolderId = id;
	shareDocumentId = "";
	shareFolderName = name;
	shareDocumentTitle = "";
	showShareDialog = true;
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
		if (target.kind === "folder") {
			// Deleting a folder moves its documents back to the root: the
			// documents.folder_id foreign key is ON DELETE SET NULL, so the
			// documents survive and reappear at the top level.
			await deleteFolder(target.id);
		} else {
			await deleteDocument(target.id);
		}
		cancelDelete();
		await refresh();
		refreshDocs();
	} catch (err) {
		console.error("FolderTree: delete failed", err);
		loadError = err instanceof Error ? err.message : m.error_generic();
		deleteBusy = false;
	}
}

// --- Category CRUD handlers ---
function openNewCategoryDialog() {
	categoryDialogMode = "create";
	selectedCategory = null;
	showCategoryDialog = true;
}

function openEditCategoryDialog(category: CategoryWithApiAccess) {
	categoryDialogMode = "edit";
	selectedCategory = category;
	showCategoryDialog = true;
}

function openDeleteCategoryDialog(category: CategoryWithApiAccess) {
	categoryDialogMode = "delete";
	selectedCategory = category;
	showCategoryDialog = true;
}

function closeCategoryDialog() {
	if (categoryBusy) return;
	showCategoryDialog = false;
	selectedCategory = null;
	categoryBusy = false;
}

async function handleCategorySave(payload: {
	name: string;
	apiMode: "unavailable" | "global" | "category";
	apiPermissionRead: boolean;
	apiPermissionEdit: boolean;
	apiPermissionWrite: boolean;
}) {
	categoryBusy = true;
	try {
		const body = {
			name: payload.name,
			apiMode: payload.apiMode,
			apiPermissionRead: payload.apiPermissionRead,
			apiPermissionEdit: payload.apiPermissionEdit,
			apiPermissionWrite: payload.apiPermissionWrite,
		};
		if (categoryDialogMode === "edit" && selectedCategory) {
			await apiFetch(
				`/api/categories/${encodeURIComponent(selectedCategory.id)}`,
				{
					method: "PATCH",
					body,
				},
			);
		} else {
			await apiFetch("/api/categories", {
				method: "POST",
				body,
			});
		}
		await refresh();
	} finally {
		categoryBusy = false;
	}
}

async function handleCategoryDelete() {
	if (!selectedCategory) return;
	categoryBusy = true;
	try {
		await deleteCategory(selectedCategory.id);
		await refresh();
	} finally {
		categoryBusy = false;
	}
}

// --- Derived: folders bucketed by category ---
//
// Folders that have a `categoryId` go into that category's bucket; the
// rest land in the synthetic "Uncategorized" group. The categories
// list is rendered in API-returned order, with the Uncategorized group
// always last so uncategorized folders don't get visually mixed in.
const UNCATEGORIZED_KEY = "__uncategorized__";

// `orderedBuckets` is the user-reorderable view (svelte-dnd-action
// mutates this directly). After a refresh, `buckets` is mirrored into
// `orderedBuckets` via the `$effect` above. `categoryBuckets` is the
// filtered subset that participates in the category dndzone —
// Uncategorized is excluded so it can never be dragged away.
const categoryBuckets = $derived(
	orderedBuckets.filter(
		(
			b,
		): b is {
			id: string;
			category: CategoryWithApiAccess;
			folders: FolderItem[];
		} => b.id !== UNCATEGORIZED_KEY && b.category !== null,
	),
);
const uncatBucket = $derived(
	orderedBuckets.find((b) => b.id === UNCATEGORIZED_KEY) ?? null,
);
const buckets = $derived.by(() => {
	const byCategory = new Map<string, FolderItem[]>();
	for (const cat of categories) byCategory.set(cat.id, []);
	const uncategorized: FolderItem[] = [];
	for (const folder of folders) {
		if (folder.categoryId && byCategory.has(folder.categoryId)) {
			byCategory.get(folder.categoryId)?.push(folder);
		} else {
			uncategorized.push(folder);
		}
	}
	const items: Array<{
		id: string;
		category: CategoryWithApiAccess | null;
		folders: FolderItem[];
	}> = [];
	for (const cat of categories) {
		items.push({
			id: cat.id,
			category: cat,
			folders: byCategory.get(cat.id) ?? [],
		});
	}
	items.push({
		id: UNCATEGORIZED_KEY,
		category: null,
		folders: uncategorized,
	});
	return items;
});
</script>

{#snippet docMenu(doc: DndDoc)}
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
      <DropdownMenuItem onSelect={() => startRename("doc", doc.id, doc.title)}>
        {m.folders_rename()}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => openShareDialogForDocument(doc.id, doc.title)}>
        <Share2 class="size-3.5" />
        {m.doc_share()}
      </DropdownMenuItem>
      <DropdownMenuItem
        class="text-destructive focus:text-destructive"
        onSelect={() => startDelete("doc", doc.id, doc.title)}
      >
        {m.action_delete()}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
{/snippet}

{#snippet copyButton(doc: DndDoc)}
  <button
    type="button"
    class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/doc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {copiedDocId === doc.id || copyLoadingDocId === doc.id ? 'opacity-100' : ''}"
    aria-label={m.action_copy_content()}
    title={m.action_copy_content()}
    disabled={copyLoadingDocId === doc.id}
    onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); void handleCopyContent(doc.id); }}
  >
    {#if copyLoadingDocId === doc.id}
      <Loader2 class="size-3.5 animate-spin" />
    {:else if copiedDocId === doc.id}
      <Check class="size-3.5" />
    {:else}
      <Copy class="size-3.5" />
    {/if}
  </button>
{/snippet}

{#snippet docRowInner(doc: DndDoc)}
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
{/snippet}

{#snippet folderBlock(folder: FolderItem)}
  <FolderNode
    {folder}
    expandedFolderIds={expandedFolderIds}
    onToggleFolder={toggleFolder}
    onRename={(id, name) => startRename("folder", id, name)}
    onDelete={(id, name) => startDelete("folder", id, name)}
    onShare={openShareDialogForFolder}
    {dragDisabled}
    {isDraggingGlobal}
    {isDraggingFolder}
    {isDraggingDoc}
    draggedDocId={draggedDocId}
    onScheduleFolderExpand={scheduleFolderExpand}
    onClearExpandTimer={clearExpandTimer}
    onConsiderDocs={handleConsider}
    onFinalizeDocs={handleFinalize}
    onConsiderSubfolders={handleNestedFolderConsider}
    onFinalizeSubfolders={handleNestedFolderFinalize}
    onDropOnFolder={handleDropOnFolder}
    folderDocsMap={folderDocsMap}
    flipDurationMs={FLIP_MS}
    {docRowInner}
    {copyButton}
    {docMenu}
  />
{/snippet}

<div class="space-y-1">
  <div class="mb-2 flex items-center justify-between gap-1">
    <a
      href="/"
      class="block flex-1 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      title={m.dashboard_title()}
    >{m.sidebar_folders()}</a>
    <button
      type="button"
      onclick={openNewCategoryDialog}
      class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={m.categories_new()}
      title={m.categories_new()}
    >
      <Plus class="size-3.5" />
    </button>
  </div>
  {#if loadError}
    <p class="px-2 text-xs text-destructive">{loadError}</p>
  {/if}
  {#if dndError}
    <p class="px-2 text-xs text-destructive">{dndError}</p>
  {/if}

<!-- Reorderable category buckets. Only real categories participate
       in the drag; the Uncategorized bucket is pinned at the end and
       is rendered separately so it never disappears. -->
  <div
    class="min-h-[8px] space-y-1"
    use:dndzone={{
      items: categoryBuckets,
      flipDurationMs: FLIP_MS,
      type: "category",
      dropTargetStyle: {},
      dragDisabled,
    }}
    onconsider={handleCategoryConsider}
    onfinalize={handleCategoryFinalize}
  >
    {#each categoryBuckets as bucket (bucket.id)}
      {@const isBucketExpanded = expandedCategoryIds.has(bucket.id)}
      <div animate:flip={{ duration: FLIP_MS }} class="group/bucket">
        <div class="flex w-full min-w-0 items-center gap-0.5">
          <button
            type="button"
            onclick={() => toggleCategory(bucket.id)}
            onmouseenter={() => {
              if (isDraggingGlobal && !isBucketExpanded) {
                scheduleCategoryExpand(bucket.id);
              }
            }}
            onmouseleave={() => {
              if (isDraggingGlobal) {
                clearCategoryExpandTimer();
              }
            }}
            ondragover={handleDragOver}
            ondrop={(e) => handleDropOnCategory(e, bucket.id)}
            aria-expanded={isBucketExpanded}
            class={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
              draggedDocId && "hover:bg-accent/40 border border-dashed border-primary/30"
            )}
          >
            {#if isBucketExpanded}
              <ChevronDown class="size-3.5 shrink-0" />
            {:else}
              <ChevronRight class="size-3.5 shrink-0" />
            {/if}
            <span class="min-w-0 truncate">{bucket.category.name}</span>
            <span class="ml-auto shrink-0 text-[10px] font-normal normal-case text-muted-foreground">
              {bucket.folders.length}
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-hover/bucket:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={m.editor_more_options()}
                  title={m.editor_more_options()}
                >
                  <MoreVertical class="size-3.5" />
                </button>
              {/snippet}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => goto(`/?category=${bucket.category.id}`)}>
                {m.action_go_to()}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => goto(`/docs/new?category=${bucket.category.id}`)}>
                {m.dashboard_new_document()}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openEditCategoryDialog(bucket.category)}>
                {m.action_edit()}
              </DropdownMenuItem>
              <DropdownMenuItem
                class="text-destructive focus:text-destructive"
                onSelect={() => openDeleteCategoryDialog(bucket.category)}
              >
                {m.action_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {#if isBucketExpanded}
          {@const zoneItems = bucketFoldersMap[bucket.id] ?? []}
          {@const rootDocs = categoryRootDocsMap[bucket.id] ?? []}
          <div class="ml-0.5 space-y-0.5 border-l border-border pl-0.5">
            <div
              class={cn(
                "min-h-[8px] space-y-0.5 transition-all duration-150",
                isDraggingFolder && zoneItems.length === 0 && "min-h-[36px] bg-accent/20 rounded border border-dashed border-muted-foreground/20"
              )}
              use:dndzone={{
                items: zoneItems,
                flipDurationMs: FLIP_MS,
                type: "folder",
                dropTargetStyle: {},
                dragDisabled,
              }}
              onconsider={handleFolderConsider(bucket.id)}
              onfinalize={handleFolderFinalize(bucket.id)}
            >
              {#each zoneItems as folder (folder.id)}
                <div animate:flip={{ duration: FLIP_MS }}>
                  {@render folderBlock(folder)}
                </div>
              {/each}
            </div>
            <!-- Root-level docs (no folder, has this category) live here
                 so users can drag them to another category or back to
                 Uncategorized. -->
            <div
              class={cn(
                "min-h-[8px] space-y-0.5 transition-all duration-150",
                isDraggingDoc && rootDocs.length === 0 && "min-h-[36px] bg-accent/20 rounded border border-dashed border-muted-foreground/20"
              )}
              use:dndzone={{
                items: rootDocs,
                flipDurationMs: FLIP_MS,
                type: "doc",
                dropTargetStyle: {},
                dragDisabled,
              }}
              onconsider={handleConsider({ kind: "category", id: bucket.id })}
              onfinalize={handleFinalize({ kind: "category", id: bucket.id })}
            >
              {#each rootDocs as doc (doc.id)}
                <div animate:flip={{ duration: FLIP_MS }} class="group/doc flex w-full min-w-0 items-center gap-1">
                  {@render docRowInner(doc)}
                  {@render copyButton(doc)}
                  {@render docMenu(doc)}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Uncategorized bucket — pinned at the end, NOT part of the
       category dndzone so users can't drop it elsewhere. -->
  {#if uncatBucket}
    <div class="group/bucket">
      <div class="flex w-full min-w-0 items-center gap-0.5">
        <button
          type="button"
          onclick={toggleUncategorized}
          onmouseenter={() => {
            if (isDraggingGlobal && !uncategorizedExpanded) {
              scheduleCategoryExpand(UNCATEGORIZED_KEY);
            }
          }}
          onmouseleave={() => {
            if (isDraggingGlobal) {
              clearCategoryExpandTimer();
            }
          }}
          ondragover={handleDragOver}
          ondrop={(e) => handleDropOnCategory(e, UNCATEGORIZED_KEY)}
          aria-expanded={uncategorizedExpanded}
          class={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            draggedDocId && "hover:bg-accent/40 border border-dashed border-primary/30"
          )}
        >
          {#if uncategorizedExpanded}
            <ChevronDown class="size-3.5 shrink-0" />
          {:else}
            <ChevronRight class="size-3.5 shrink-0" />
          {/if}
          <span class="min-w-0 truncate">{m.sidebar_uncategorized()}</span>
          <span class="ml-auto shrink-0 text-[10px] font-normal normal-case text-muted-foreground">
            {uncatBucket.folders.length}
          </span>
        </button>
      </div>
      {#if uncategorizedExpanded}
        {@const zoneItems = bucketFoldersMap[UNCATEGORIZED_KEY] ?? []}
        <div class="ml-0.5 space-y-0.5 border-l border-border pl-0.5">
          <div
            class={cn(
              "min-h-[8px] space-y-0.5 transition-all duration-150",
              isDraggingFolder && zoneItems.length === 0 && "min-h-[36px] bg-accent/20 rounded border border-dashed border-muted-foreground/20"
            )}
            use:dndzone={{
              items: zoneItems,
              flipDurationMs: FLIP_MS,
              type: "folder",
              dropTargetStyle: {},
              dragDisabled,
            }}
            onconsider={handleFolderConsider(UNCATEGORIZED_KEY)}
            onfinalize={handleFolderFinalize(UNCATEGORIZED_KEY)}
          >
            {#each zoneItems as folder (folder.id)}
              <div animate:flip={{ duration: FLIP_MS }}>
                {@render folderBlock(folder)}
              </div>
            {/each}
          </div>
          <!-- Root-level documents (no folder, no category) live here so
               users have a way to see and re-file docs that have been
               pulled out of a folder. -->
          <div
            class={cn(
              "min-h-[8px] space-y-0.5 transition-all duration-150",
              isDraggingDoc && rootItems.length === 0 && "min-h-[36px] bg-accent/20 rounded border border-dashed border-muted-foreground/20"
            )}
            use:dndzone={{ items: rootItems, flipDurationMs: FLIP_MS, type: "doc", dropTargetStyle: {}, dragDisabled }}
            onconsider={handleConsider({ kind: "root" })}
            onfinalize={handleFinalize({ kind: "root" })}
          >
            {#each rootItems as doc (doc.id)}
              <div animate:flip={{ duration: FLIP_MS }} class="group/doc flex w-full min-w-0 items-center gap-1">
                {@render docRowInner(doc)}
                {@render copyButton(doc)}
                {@render docMenu(doc)}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

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

<!-- Rename dialog (folders and documents) -->
<Dialog bind:open={showRenameDialog} onOpenChange={(next) => { if (!next) closeRenameDialog(); }}>
  <DialogHeader>
    <DialogTitle>{m.folders_rename()}</DialogTitle>
    <DialogDescription>
      {renameTarget?.kind === "folder" ? m.folders_name_placeholder() : m.doc_title_label()}
    </DialogDescription>
  </DialogHeader>

  <form onsubmit={submitRename} class="space-y-4">
    <div class="space-y-2">
      <Label for="rename-input">
        {renameTarget?.kind === "folder" ? m.folders_name_placeholder() : m.doc_title_label()}
      </Label>
      <Input
        id="rename-input"
        name="name"
        type="text"
        bind:value={renameValue}
        maxlength={255}
        required
        disabled={renameSubmitting}
        aria-invalid={renameError ? "true" : undefined}
        aria-describedby={renameError ? "rename-input-error" : undefined}
        autocomplete="off"
      />
      {#if renameError}
        <p id="rename-input-error" class="text-xs text-destructive" role="alert">{renameError}</p>
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

<!-- Delete confirmation (folders and documents) -->
<ConfirmDialog
  bind:open={showDeleteDialog}
  title={deleteTarget?.kind === "folder" ? m.folders_delete_title() : m.doc_delete()}
  description={deleteTarget?.kind === "folder"
    ? "Delete this folder? Its documents will be moved to the root and will not be deleted."
    : m.doc_delete_confirm()}
  confirmLabel={m.action_delete()}
  cancelLabel={m.action_cancel()}
  variant="destructive"
  busy={deleteBusy}
  onConfirm={confirmDelete}
  onCancel={cancelDelete}
/>

<!-- Category CRUD dialog -->
<CategoryDialog
  bind:open={showCategoryDialog}
  mode={categoryDialogMode}
  category={selectedCategory ?? undefined}
  onSave={handleCategorySave}
  onDelete={handleCategoryDelete}
  onClose={closeCategoryDialog}
/>

<ShareDialog
  bind:open={showShareDialog}
  documentId={shareDocumentId}
  documentTitle={shareDocumentTitle}
  folderId={shareFolderId}
  folderName={shareFolderName}
/>
