<script lang="ts">
import { Badge } from "@hiai-gg/hiai-ui/components/ui/badge/index";
import { Button } from "@hiai-gg/hiai-ui/components/ui/button/index";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@hiai-gg/hiai-ui/components/ui/dropdown-menu/index";
import { Label } from "@hiai-gg/hiai-ui/components/ui/label/index";
import SelectRoot from "@hiai-gg/hiai-ui/components/ui/select/select.svelte";
import SelectContent from "@hiai-gg/hiai-ui/components/ui/select/select-content.svelte";
import SelectItem from "@hiai-gg/hiai-ui/components/ui/select/select-item.svelte";
import SelectTrigger from "@hiai-gg/hiai-ui/components/ui/select/select-trigger.svelte";
import SelectValue from "@hiai-gg/hiai-ui/components/ui/select/select-value.svelte";
import {
	DropdownMenu as DropdownMenuPrimitive,
	Select as SelectPrimitive,
} from "bits-ui";
import {
	ArrowLeft,
	Calendar,
	Check,
	ChevronDown,
	ChevronRight,
	Clock,
	Copy,
	FileText,
	Folder,
	FolderKanban,
	FolderOpen,
	LayoutDashboard,
	Loader2,
	MoreVertical,
	Plus,
	RotateCcw,
	Share2,
	Tag,
	Upload,
	X,
} from "lucide-svelte";

const Select = {
	Root: SelectRoot,
	Content: SelectContent,
	Item: SelectItem,
	Trigger: SelectTrigger,
	Value: SelectValue,
};

import { ConfirmDialog } from "@hiai-gg/hiai-ui/components/ui/confirm-dialog/index";
import { invalidateAll } from "$app/navigation";
import { page } from "$app/state";
import type { Category } from "$lib/api/categories";
import { apiFetch } from "$lib/api/client";
import { createDocument, listDocuments } from "$lib/api/documents";
import { createFolder, duplicateDocument, listFolders } from "$lib/api/folders";
import type { Tag as ApiTag } from "$lib/api/tags";
import DatePicker from "$lib/components/DatePicker.svelte";
import DocumentCard from "$lib/components/DocumentCard.svelte";
import FolderCard from "$lib/components/FolderCard.svelte";
import FolderDialog from "$lib/components/FolderDialog.svelte";
import ImportProgress, {
	type ImportItem,
} from "$lib/components/ImportProgress.svelte";
import ShareDialog from "$lib/components/ShareDialog.svelte";
import { getFrontendExtensions } from "$lib/extensions/context";
import { resolveExtensions } from "$lib/extensions/resolve";
import type { ExtensionVisibilityContext } from "$lib/extensions/types";
import {
	getDocsmintRequestAdapter,
	getDocsmintRouteAdapter,
	navigateDocsmintRoute,
	resolveDocsmintRoute,
} from "$lib/hosts/route-context";
import { getDocsmintShareAdapter } from "$lib/hosts/share-context";
import * as m from "$lib/paraglide/messages.js";
import { refreshFolders } from "$lib/stores/subfolders-refresh-store.svelte.js";
import { refreshDocs } from "$lib/stores/tag-store.svelte.js";
import type { Document, Folder as FolderType } from "$lib/types.js";

export interface HiaiDocsDashboardData {
	categories: Category[];
	tags: ApiTag[];
	activeFolder: FolderType | null;
	breadcrumb: Array<{ id: string; name: string }>;
	rootFolders: FolderType[];
	recentDocs: Document[];
}

const { data, extensionContext = { pathname: "/" } } = $props<{
	data: HiaiDocsDashboardData;
	extensionContext?: ExtensionVisibilityContext;
}>();

const frontendExtensions = getFrontendExtensions();
const route = getDocsmintRouteAdapter();
const request = getDocsmintRequestAdapter();
const share = getDocsmintShareAdapter();
const dashboardWidgets = $derived.by(() =>
	resolveExtensions(frontendExtensions.dashboardWidgets, extensionContext),
);
const importAccept = $derived.by(() => {
	const formats = [".md", ".txt", ".json", ".docx"];
	if (extensionContext.capabilities?.["docsmint.import.tier2"]) {
		formats.push(".pdf", "image/*", "audio/*");
	}
	if (extensionContext.capabilities?.["docsmint.import.tier3"]) {
		formats.push("video/*", ".m4v", ".mkv", ".webm");
	}
	return formats.join(",");
});

// --- Query parameters via SvelteKit page state ---
const activeFolderId = $derived(page.url.searchParams.get("folder") || null);
const activeCategoryId = $derived(
	page.url.searchParams.get("category") || null,
);

// --- Active Filter Inputs (Local State) ---
let searchQuery = $state("");
let selectedTagId = $state<string | null>(null);
let dateFrom = $state("");
let dateTo = $state("");

// Sync inputs with URL params if they exist
$effect(() => {
	searchQuery = page.url.searchParams.get("q") ?? "";
	selectedTagId = page.url.searchParams.get("tag") ?? null;
	dateFrom = page.url.searchParams.get("dateFrom") ?? "";
	dateTo = page.url.searchParams.get("dateTo") ?? "";
});

// --- Dialog states ---
let showFolderDialog = $state(false);
let folderDialogMode = $state<"create" | "edit">("create");
let folderDialogTarget = $state<{ id: string; name: string } | null>(null);

let showDeleteFolderDialog = $state(false);
let deleteFolderTargetId = $state<string | null>(null);
let deleteFolderBusy = $state(false);
let showDeleteDocumentDialog = $state(false);
let deleteDocumentTargetId = $state<string | null>(null);
let deleteDocumentTargetTitle = $state("");
let deleteDocumentBusy = $state(false);

let showShareDialog = $state(false);
type ShareTarget =
	| { kind: "document"; documentId: string; title: string }
	| { kind: "folder"; folderId: string; name: string }
	| { kind: "category"; categoryId: string; name: string };
let shareTarget = $state<ShareTarget | null>(null);
let importOpen = $state(false);
let importItems = $state<ImportItem[]>([]);
let importInput = $state<HTMLInputElement | undefined>(undefined);
let duplicatingDocumentId = $state<string | null>(null);
let optimisticDocuments = $state<Document[]>([]);

function openShareDialogForDocument(id: string, title: string) {
	shareTarget = { kind: "document", documentId: id, title };
	showShareDialog = true;
}

function openShareDialogForFolder(id: string, name: string) {
	shareTarget = { kind: "folder", folderId: id, name };
	showShareDialog = true;
}

function openShareDialogForCategory(id: string, name: string) {
	shareTarget = { kind: "category", categoryId: id, name };
	showShareDialog = true;
}

// --- Mutating actions ---
function handleNewDocument() {
	let url = "/docs/new";
	const params = new URLSearchParams();
	if (activeFolderId) params.set("folder", activeFolderId);
	if (activeCategoryId) params.set("category", activeCategoryId);
	const qs = params.toString();
	if (qs) url += `?${qs}`;
	return navigateDocsmintRoute(route, url);
}

function handleRenameFolder(id: string) {
	const folder = activeFolderId
		? data.activeFolder?.children?.find((c: FolderType) => c.id === id)
		: data.rootFolders.find((f: FolderType) => f.id === id);
	if (!folder) return;
	folderDialogMode = "edit";
	folderDialogTarget = { id: folder.id, name: folder.name };
	showFolderDialog = true;
}

async function saveFolder(name: string) {
	if (folderDialogMode === "create") {
		await apiFetch(
			"/api/folders",
			{
				method: "POST",
				body: JSON.stringify({
					name,
					parentId: activeFolderId || null,
					categoryId: activeFolderId ? null : activeCategoryId || null,
				}),
			},
			request.fetch,
		);
	} else if (folderDialogMode === "edit" && folderDialogTarget) {
		await apiFetch(
			`/api/folders/${folderDialogTarget.id}`,
			{
				method: "PATCH",
				body: JSON.stringify({ name }),
			},
			request.fetch,
		);
	}
	showFolderDialog = false;
	refreshFolders();
	await invalidateAll();
}

function handleDeleteFolder(id: string) {
	deleteFolderTargetId = id;
	showDeleteFolderDialog = true;
}

async function confirmDeleteFolder() {
	const id = deleteFolderTargetId;
	if (!id || deleteFolderBusy) return;
	deleteFolderBusy = true;
	try {
		await apiFetch(`/api/folders/${id}`, { method: "DELETE" }, request.fetch);
		showDeleteFolderDialog = false;
		deleteFolderTargetId = null;
		await invalidateAll();
		refreshFolders();
		refreshDocs();
	} catch (e) {
		console.error("Failed to delete folder", e);
	} finally {
		deleteFolderBusy = false;
	}
}

function handleDeleteDocument(id: string) {
	const document = filteredDocuments.find(
		(candidate: { id: string; title?: string }) => candidate.id === id,
	);
	deleteDocumentTargetId = id;
	deleteDocumentTargetTitle = document?.title || m.doc_title_placeholder();
	showDeleteDocumentDialog = true;
}

async function confirmDeleteDocument() {
	const id = deleteDocumentTargetId;
	if (!id || deleteDocumentBusy) return;
	deleteDocumentBusy = true;
	try {
		await apiFetch(`/api/documents/${id}`, { method: "DELETE" }, request.fetch);
		showDeleteDocumentDialog = false;
		deleteDocumentTargetId = null;
		await invalidateAll();
		refreshDocs();
	} catch (e) {
		console.error("Failed to delete document", e);
	} finally {
		deleteDocumentBusy = false;
	}
}

async function handleDuplicateDocument(id: string) {
	if (duplicatingDocumentId) return;
	duplicatingDocumentId = id;
	try {
		const duplicate = await duplicateDocument(id, request.fetch);
		optimisticDocuments = [
			...optimisticDocuments.filter((doc) => doc.id !== duplicate.id),
			duplicate,
		];
		await invalidateAll();
		const currentDocuments = data.activeFolder?.documents ?? data.recentDocs;
		optimisticDocuments = optimisticDocuments.filter(
			(doc) =>
				!currentDocuments.some((current: Document) => current.id === doc.id),
		);
		refreshDocs();
	} catch (e) {
		console.error("Failed to duplicate document", e);
	} finally {
		duplicatingDocumentId = null;
	}
}

// --- Import functions ---
function triggerImport() {
	if (extensionContext.capabilities?.["docsmint.import.manager"]) {
		navigateDocsmintRoute(route, "/organize");
		return;
	}
	importInput?.click();
}

async function handleImportFile(e: Event) {
	const input = e.target as HTMLInputElement;
	if (!input.files || input.files.length === 0) return;
	const files = Array.from(input.files);

	importItems = files.map((f) => ({
		filename: f.name,
		status: "queued",
	}));
	importOpen = true;

	try {
		const results = await importDocuments(
			files,
			activeFolderId || undefined,
			request.fetch,
			{
				concurrency: 3,
				onItemStarted: (index) => {
					importItems = importItems.map((item, itemIndex) =>
						itemIndex === index ? { ...item, status: "uploading" } : item,
					);
				},
				onItemSettled: (result, index) => {
					importItems = importItems.map((item, itemIndex) => {
						if (itemIndex !== index) return item;
						if (result.status === "ok") {
							return {
								...item,
								status: "done",
								documentId: result.document?.id,
							};
						}
						return {
							...item,
							status: "error",
							error: result.error || "Failed",
						};
					});

					if (result.status === "ok" && result.document) {
						const doc = result.document;
						const importedDocument: Document = {
							id: doc.id,
							title: doc.title,
							content: doc.content,
							folderId: doc.folderId ?? null,
							folderName: doc.folderName ?? "",
							categoryId: doc.categoryId ?? null,
							tags: (doc.tags ?? []).map((tag) => tag.id),
							createdAt: doc.createdAt,
							updatedAt: doc.updatedAt,
							excerpt: doc.excerpt ?? doc.content?.slice(0, 200) ?? "",
						};
						optimisticDocuments = [
							...optimisticDocuments.filter(
								(existing) => existing.id !== importedDocument.id,
							),
							importedDocument,
						];
					}
				},
			},
		);

		// Force any missing response slot into an error state. Normal requests
		// settle through onItemSettled above, so this is only a protocol guard.
		importItems = importItems.map((item, index) =>
			results.items[index]
				? item
				: { ...item, status: "error", error: "No response" },
		);

		await invalidateAll();
		refreshDocs();
	} catch (err) {
		console.error("Import failed:", err);
		importItems = importItems.map((item) => ({
			...item,
			status: "error",
			error: err instanceof Error ? err.message : m.error_generic(),
		}));
	} finally {
		input.value = "";
	}
}

// Helper since we import importDocuments locally in load but import is in documents API
import { importDocuments } from "$lib/api/documents";

function closeImport() {
	importOpen = false;
	setTimeout(() => {
		importItems = [];
	}, 200);
}

// --- Reset/Clear Filters ---
function clearFilters() {
	searchQuery = "";
	selectedTagId = null;
	dateFrom = "";
	dateTo = "";

	const params = new URLSearchParams(page.url.searchParams);
	params.delete("q");
	params.delete("tag");
	params.delete("dateFrom");
	params.delete("dateTo");
	return navigateDocsmintRoute(route, `/?${params.toString()}`);
}

function updateFilters() {
	const params = new URLSearchParams(page.url.searchParams);
	if (searchQuery.trim()) params.set("q", searchQuery);
	else params.delete("q");

	if (selectedTagId) params.set("tag", selectedTagId);
	else params.delete("tag");

	if (dateFrom) params.set("dateFrom", dateFrom);
	else params.delete("dateFrom");

	if (dateTo) params.set("dateTo", dateTo);
	else params.delete("dateTo");

	return navigateDocsmintRoute(route, `/?${params.toString()}`, {
		replaceState: true,
		keepFocus: true,
		noScroll: true,
	});
}

const hasActiveFilters = $derived(
	searchQuery.trim() !== "" ||
		selectedTagId !== null ||
		dateFrom !== "" ||
		dateTo !== "",
);

// --- Filtering Logic (Client Side) ---
const filteredFolders = $derived.by(() => {
	let list = activeFolderId
		? (data.activeFolder?.children ?? [])
		: data.rootFolders;

	// Filter by active category if at root workspace
	if (!activeFolderId && activeCategoryId) {
		list = list.filter((f: FolderType) => f.categoryId === activeCategoryId);
	}

	// Filter by search query locally
	if (searchQuery.trim()) {
		const q = searchQuery.toLowerCase();
		list = list.filter((f: FolderType) => f.name.toLowerCase().includes(q));
	}

	// Filter by date range (updatedAt)
	if (dateFrom) {
		const fromTime = new Date(dateFrom).getTime();
		list = list.filter(
			(f: FolderType) => new Date(f.updatedAt).getTime() >= fromTime,
		);
	}
	if (dateTo) {
		const toTime = new Date(dateTo).getTime();
		list = list.filter(
			(f: FolderType) => new Date(f.updatedAt).getTime() <= toTime,
		);
	}

	return list;
});

const filteredDocuments = $derived.by(() => {
	let list = activeFolderId
		? (data.activeFolder?.documents ?? [])
		: data.recentDocs;
	const extras = optimisticDocuments.filter(
		(doc) => !list.some((current: Document) => current.id === doc.id),
	);
	if (extras.length > 0) list = [...list, ...extras];
	// Keep the newest document first after optimistic imports/duplicates too.
	// The API already returns this order, but local extras are otherwise
	// appended and end up at the bottom of the single-column mobile grid.
	list = [...list].sort(
		(a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
	);

	// Filter by search query locally
	if (searchQuery.trim()) {
		const q = searchQuery.toLowerCase();
		list = list.filter(
			(d: Document) =>
				d.title.toLowerCase().includes(q) ||
				d.content?.toLowerCase().includes(q),
		);
	}

	// Filter by tag
	if (selectedTagId) {
		const tagId = selectedTagId;
		list = list.filter((d: Document) => d.tags.includes(tagId));
	}

	// Filter by date range (updatedAt)
	if (dateFrom) {
		const fromTime = new Date(dateFrom).getTime();
		list = list.filter(
			(d: Document) => new Date(d.updatedAt).getTime() >= fromTime,
		);
	}
	if (dateTo) {
		const toTime = new Date(dateTo).getTime();
		list = list.filter(
			(d: Document) => new Date(d.updatedAt).getTime() <= toTime,
		);
	}

	return list;
});

// Build grouped sections for folders (grouped by category)
const visibleSections = $derived.by(() => {
	const byCategory = new Map<string, FolderType[]>();
	for (const cat of data.categories) byCategory.set(cat.id, []);
	const uncategorized: FolderType[] = [];

	for (const folder of filteredFolders) {
		if (folder.categoryId && byCategory.has(folder.categoryId)) {
			byCategory.get(folder.categoryId)?.push(folder);
		} else {
			uncategorized.push(folder);
		}
	}

	const items: Array<{
		key: string;
		category: Category | null;
		folders: FolderType[];
	}> = [];
	for (const cat of data.categories) {
		items.push({
			key: cat.id,
			category: cat,
			folders: byCategory.get(cat.id) ?? [],
		});
	}
	items.push({
		key: "__uncategorized__",
		category: null,
		folders: uncategorized,
	});

	// If filtering by a single category, only show that category section!
	if (activeCategoryId) {
		return items.filter((s) => s.key === activeCategoryId);
	}

	return items.filter((s) => s.folders.length > 0);
});

const isRootEmpty = $derived(
	filteredFolders.length === 0 && filteredDocuments.length === 0,
);

const isFolderEmpty = $derived(
	activeFolderId &&
		(data.activeFolder?.children?.length ?? 0) === 0 &&
		(data.activeFolder?.documents?.length ?? 0) === 0,
);
</script>

<svelte:head>
  <title>
    {activeFolderId
      ? m.folder_page_title({ name: data.activeFolder?.name || "Folder" })
      : activeCategoryId
        ? (data.categories.find((c: Category) => c.id === activeCategoryId)?.name || "Category")
        : m.dashboard_page_title()}
  </title>
</svelte:head>

<div class="dashboard-shell mx-auto max-w-5xl px-6 py-8">
  <!-- Header -->
  <div class="dashboard-header mb-8 flex flex-wrap items-center justify-between gap-4">
    <div class="dashboard-context-identity flex items-center gap-3 flex-1 min-w-0">
      {#if activeFolderId}
        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0"
          onclick={() => {
            const parentId = data.activeFolder?.parentId;
            if (parentId) {
				return navigateDocsmintRoute(route, `/?folder=${parentId}`);
            } else {
				return navigateDocsmintRoute(route, "/");
            }
          }}
          title={m.action_back()}
        >
          <ArrowLeft class="size-4" />
        </Button>
        <FolderOpen class="size-7 shrink-0 text-primary" />
        <h1 class="text-2xl font-semibold tracking-tight truncate">
          {data.activeFolder?.name || "Folder"}
        </h1>
        {@const activeFolderCategoryId = data.activeFolder?.categoryId}
        {#if activeFolderCategoryId}
          {@const cat = data.categories.find((c: Category) => c.id === activeFolderCategoryId)}
          {#if cat}
            <Badge variant="secondary">{cat.name}</Badge>
          {/if}
        {/if}
      {:else if activeCategoryId}
        <Button
          variant="ghost"
          size="icon"
          class="size-8 shrink-0"
			onclick={() => navigateDocsmintRoute(route, "/")}
          title={m.action_back()}
        >
          <ArrowLeft class="size-4" />
        </Button>
        <FolderKanban class="size-7 shrink-0 text-primary" />
        <h1 class="text-2xl font-semibold tracking-tight truncate">
          {data.categories.find((c: Category) => c.id === activeCategoryId)?.name || "Category"}
        </h1>
      {:else}
        <div class="dashboard-identity flex items-center gap-3">
          <div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <LayoutDashboard class="size-5 text-primary" />
          </div>
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">{m.dashboard_title()}</h1>
            <p class="text-sm text-muted-foreground">{m.dashboard_subtitle()}</p>
          </div>
        </div>
      {/if}
    </div>

    <!-- Top Action Buttons -->
    <div class="dashboard-header-actions ml-auto flex items-center justify-end gap-2">
      <input
        type="file"
        accept={importAccept}
        multiple
        class="hidden"
        bind:this={importInput}
        onchange={handleImportFile}
      />
      <Button variant="outline" size="sm" onclick={triggerImport} class="text-muted-foreground" aria-label={m.dashboard_import()}>
        <Upload class="size-4" />
        <span class="dashboard-action-label">{m.dashboard_import()}</span>
      </Button>
      <Button size="sm" onclick={handleNewDocument} aria-label={m.dashboard_new_document()}>
        <Plus class="size-4" />
        <span class="dashboard-action-label">{m.dashboard_new_document()}</span>
      </Button>
      {#if activeFolderId && data.activeFolder}
        <Button variant="outline" size="sm" onclick={() => openShareDialogForFolder(activeFolderId, data.activeFolder?.name || "Folder")} aria-label={m.doc_share()}>
          <Share2 class="size-3.5" />
          <span class="dashboard-action-label">{m.doc_share()}</span>
        </Button>
      {:else if activeCategoryId}
        {@const activeCategory = data.categories.find((category: Category) => category.id === activeCategoryId)}
        {#if activeCategory}
        <Button variant="outline" size="sm" onclick={() => openShareDialogForCategory(activeCategory.id, activeCategory.name)} aria-label={m.doc_share()}>
          <Share2 class="size-3.5" />
          <span class="dashboard-action-label">{m.doc_share()}</span>
        </Button>
        {/if}
      {/if}
    </div>
  </div>

  {#if dashboardWidgets.length > 0}
    <section
      class="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2"
      data-hiai-docs-extension-zone="dashboard-widgets"
      aria-label="Dashboard extensions"
    >
      {#each dashboardWidgets as widget (widget.id)}
        {@const Widget = widget.component}
        <div
          class={[
            widget.chrome === false
              ? "contents"
              : "rounded-xl border border-border bg-card p-4",
            widget.colSpan === 12 && "md:col-span-2",
          ]}
          data-hiai-docs-extension-id={widget.id}
        >
          {#if widget.title}
            <h2 class="mb-3 text-sm font-semibold">{widget.title}</h2>
          {/if}
          <Widget userId={extensionContext.userId} />
        </div>
      {/each}
    </section>
  {/if}

  <!-- Breadcrumbs (for folder detail view) -->
  {#if activeFolderId && data.breadcrumb?.length > 0}
    <nav class="mb-6 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumbs">
      <a href={resolveDocsmintRoute(route, "/")} class="hover:text-foreground transition-colors">Home</a>
      {#each data.breadcrumb as path, idx (path.id)}
        <ChevronRight class="size-3.5" />
        {#if idx === data.breadcrumb.length - 1}
          <span class="font-medium text-foreground truncate max-w-[150px]">{path.name}</span>
        {:else}
          <a href={resolveDocsmintRoute(route, `/?folder=${encodeURIComponent(path.id)}`)} class="hover:text-foreground transition-colors truncate max-w-[150px]">
            {path.name}
          </a>
        {/if}
      {/each}
    </nav>
  {/if}

  <!-- Search & Filters Grid Zone -->
  <div class="mb-8 grid grid-cols-1 gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
    <!-- Local Search Input -->
    <div class="space-y-1.5">
      <Label for="dash-search" class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Search</Label>
      <input
        id="dash-search"
        type="text"
        bind:value={searchQuery}
        oninput={updateFilters}
        placeholder="Filter current view..."
        class="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>

    <!-- Category selector (only shown at root workspace) -->
    <div class="space-y-1.5">
      <Label for="dash-category" class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Category</Label>
      {#if activeFolderId}
        <div class="h-9 w-full rounded-md border border-input bg-muted/50 px-3 py-2 text-sm shadow-sm opacity-60 flex items-center select-none">
          Inherited from folder
        </div>
      {:else}
        <Select.Root
          type="single"
          value={activeCategoryId ?? "all"}
          onValueChange={(val: string) => {
            const params = new URLSearchParams(page.url.searchParams);
            if (val && val !== "all") params.set("category", val);
            else params.delete("category");
			return navigateDocsmintRoute(route, `/?${params.toString()}`);
          }}
        >
          <Select.Trigger class="w-full text-foreground flex items-center justify-between bg-background border border-input px-3 py-2 text-sm rounded-md shadow-sm h-9">
            <Select.Value placeholder="All Categories">
              {activeCategoryId ? (data.categories.find((c: Category) => c.id === activeCategoryId)?.name ?? "All Categories") : "All Categories"}
            </Select.Value>
            <ChevronDown class="size-4 opacity-50" />
          </Select.Trigger>
          <SelectPrimitive.Portal>
            <Select.Content class="w-[var(--bits-select-trigger-width)]">
              <Select.Item value="all">All Categories</Select.Item>
              {#each data.categories as cat (cat.id)}
                <Select.Item value={cat.id}>{cat.name}</Select.Item>
              {/each}
            </Select.Content>
          </SelectPrimitive.Portal>
        </Select.Root>
      {/if}
    </div>

    <!-- Tag Dropdown Selection -->
    <div class="space-y-1.5">
      <Label for="dash-tag" class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Tag</Label>
      <Select.Root
        type="single"
        value={selectedTagId ?? "all"}
        onValueChange={(val: string) => {
          selectedTagId = val === "all" ? null : val;
          updateFilters();
        }}
      >
        <Select.Trigger class="w-full text-foreground flex items-center justify-between bg-background border border-input px-3 py-2 text-sm rounded-md shadow-sm h-9">
          <Select.Value placeholder="All Tags">
            {selectedTagId ? (data.tags.find((t: ApiTag) => t.id === selectedTagId)?.name ?? "All Tags") : "All Tags"}
          </Select.Value>
          <ChevronDown class="size-4 opacity-50" />
        </Select.Trigger>
        <SelectPrimitive.Portal>
          <Select.Content class="w-[var(--bits-select-trigger-width)]">
            <Select.Item value="all"><span class="inline-flex items-center gap-2"><span class="size-2 rounded-full bg-muted-foreground"></span>All Tags</span></Select.Item>
            {#each data.tags as tag (tag.id)}
              <Select.Item value={tag.id}><span class="inline-flex items-center gap-2"><span class="size-2 rounded-full" style="background-color: {tag.color || '#cccccc'}"></span>{tag.name}</span></Select.Item>
            {/each}
          </Select.Content>
        </SelectPrimitive.Portal>
      </Select.Root>
    </div>

    <!-- Date From -->
    <div class="space-y-1.5">
      <Label for="date-from" class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">From Date</Label>
      <DatePicker
        id="date-from"
        bind:value={dateFrom}
        onchange={updateFilters}
        placeholder="From Date"
      />
    </div>

    <!-- Date To -->
    <div class="space-y-1.5">
      <Label for="date-to" class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">To Date</Label>
      <DatePicker
        id="date-to"
        bind:value={dateTo}
        onchange={updateFilters}
        placeholder="To Date"
      />
    </div>
  </div>

  <!-- Active Filters Summary & Clear Filters -->
  {#if hasActiveFilters}
    <div class="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/30 px-4 py-2 text-sm">
      <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Filters:</span>
      {#if searchQuery.trim()}
        <Badge variant="secondary" class="flex items-center gap-1">
          <span>Search: {searchQuery}</span>
          <button onclick={() => { searchQuery = ""; updateFilters(); }} class="text-muted-foreground hover:text-foreground">
            <X class="size-3" />
          </button>
        </Badge>
      {/if}
      {#if selectedTagId}
        {@const tag = data.tags.find((t: ApiTag) => t.id === selectedTagId)}
        {#if tag}
          <Badge variant="secondary" class="flex items-center gap-1.5">
            <span class="size-2 rounded-full" style="background-color: {tag.color || '#cccccc'}"></span>
            <span>Tag: {tag.name}</span>
            <button onclick={() => { selectedTagId = null; updateFilters(); }} class="text-muted-foreground hover:text-foreground">
              <X class="size-3" />
            </button>
          </Badge>
        {/if}
      {/if}
      {#if dateFrom || dateTo}
        <Badge variant="secondary" class="flex items-center gap-1">
          <span>Date: {dateFrom || "*"} to {dateTo || "*"}</span>
          <button onclick={() => { dateFrom = ""; dateTo = ""; updateFilters(); }} class="text-muted-foreground hover:text-foreground">
            <X class="size-3" />
          </button>
        </Badge>
      {/if}
      <button
        onclick={clearFilters}
        class="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-destructive hover:underline"
      >
        <RotateCcw class="size-3" />
        Clear Filters
      </button>
    </div>
  {/if}

  <!-- MAIN CONTENT AREA -->
  {#if activeFolderId}
    <!-- ================= FOLDER VIEW ================= -->
    {#if isFolderEmpty}
      <!-- Empty folder state -->
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <div class="mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
          <FolderOpen class="size-8 text-muted-foreground" />
        </div>
        <h2 class="mb-2 text-lg font-semibold">Folder is empty</h2>
        <p class="mb-6 max-w-sm text-sm text-muted-foreground">
          Create a new document, subfolder, or drag and drop items here to get started.
        </p>
      </div>
    {:else}
      <!-- Subfolders List -->
      {#if filteredFolders.length > 0}
        <div class="mb-8">
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Subfolders
          </h2>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each filteredFolders as folder (folder.id)}
              <FolderCard
                {folder}
                onDelete={handleDeleteFolder}
                onRename={handleRenameFolder}
				onShare={openShareDialogForFolder}
              />
            {/each}
          </div>
        </div>
      {/if}

      <!-- Documents List -->
      {#if filteredDocuments.length > 0}
        <div>
          <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {m.nav_documents()}
          </h2>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each filteredDocuments as doc (doc.id)}
              <DocumentCard
                document={doc}
                onDelete={handleDeleteDocument}
                onDuplicate={handleDuplicateDocument}
				onShare={openShareDialogForDocument}
                duplicateBusy={duplicatingDocumentId === doc.id}
              />
            {/each}
          </div>
        </div>
      {/if}
    {/if}

  {:else}
    <!-- ================= DASHBOARD / ROOT VIEW ================= -->
    {#if isRootEmpty}
      <!-- Empty Workspace State -->
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <div class="mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
          <FileText class="size-8 text-muted-foreground" />
        </div>
        <h2 class="mb-2 text-lg font-semibold">{m.folders_empty()}</h2>
        <p class="mb-6 max-w-sm text-sm text-muted-foreground">
          {m.folders_empty_description()}
        </p>
      </div>
    {:else}
      <!-- Grouped Category Sections of Folders -->
      {#each visibleSections as section (section.key)}
        {@const docSum = section.folders.reduce((acc, f) => acc + f.documentCount, 0)}
        <section id="category-{section.key}" class="mb-8">
          <div class="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <h2>{section.category ? section.category.name : m.sidebar_uncategorized()}</h2>
            <Badge variant="secondary" class="text-[10px]">
              {docSum} {docSum === 1 ? 'file' : 'files'}
            </Badge>
            {#if section.category}
              <DropdownMenu>
                <DropdownMenuTrigger class="ml-auto inline-flex size-8 items-center justify-center rounded-md hover:bg-accent" aria-label={m.editor_more_options()}>
                  <MoreVertical class="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuPrimitive.Portal>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => openShareDialogForCategory(section.category!.id, section.category!.name)}>
                      <Share2 class="size-4" />
                      {m.doc_share()}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenuPrimitive.Portal>
              </DropdownMenu>
            {/if}
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each section.folders as folder (folder.id)}
              <FolderCard
                {folder}
                onDelete={handleDeleteFolder}
                onRename={handleRenameFolder}
				onShare={openShareDialogForFolder}
              />
            {/each}
          </div>
        </section>
      {/each}

      <!-- Recent Documents Section (shown at the bottom) -->
      {#if filteredDocuments.length > 0}
        <div class="mt-12 border-t border-border/60 pt-8">
          <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {hasActiveFilters ? "Filtered Documents" : "Recent Documents"}
          </h2>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each filteredDocuments as doc (doc.id)}
              <DocumentCard
                document={doc}
                onDelete={handleDeleteDocument}
                onDuplicate={handleDuplicateDocument}
				onShare={openShareDialogForDocument}
                duplicateBusy={duplicatingDocumentId === doc.id}
              />
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .dashboard-shell {
    position: relative;
  }

  @media (max-width: 767px) {
    .dashboard-header {
      min-height: 44px;
    }

    .dashboard-header-actions {
      position: absolute;
      top: calc(0.75rem + env(safe-area-inset-top));
      right: 0.75rem;
      z-index: 10;
    }

	.dashboard-context-identity {
		margin-left: 56px;
		min-width: 0;
	}
  }

  @media (max-width: 520px) {
    .dashboard-header-actions :global(button) {
      width: 40px;
      height: 40px;
      padding: 0;
    }

    .dashboard-action-label {
      display: none;
    }
  }

  @media (max-width: 449px) {
    .dashboard-context-identity {
		margin-left: 52px;
    }

	.dashboard-context-identity p {
		display: none;
	}

	.dashboard-context-identity h1 {
		font-size: 1.25rem;
	}
  }
</style>

<!-- Folder creation / renaming dialog -->
<FolderDialog
  bind:open={showFolderDialog}
  mode={folderDialogMode}
  folder={folderDialogTarget}
  onSave={saveFolder}
/>

<!-- Delete folder confirmation dialog -->
<ConfirmDialog
  bind:open={showDeleteFolderDialog}
  title={m.folders_delete_title()}
  description={m.folders_delete_description()}
  confirmLabel={m.folders_delete()}
  cancelLabel={m.action_cancel()}
  variant="destructive"
  busy={deleteFolderBusy}
  onConfirm={confirmDeleteFolder}
  onCancel={() => (showDeleteFolderDialog = false)}
/>

<ConfirmDialog
  bind:open={showDeleteDocumentDialog}
  title="Move to Trash?"
  description={`“${deleteDocumentTargetTitle}” will be moved to Trash and can be restored later.`}
  confirmLabel="Move to Trash"
  cancelLabel={m.action_cancel()}
  variant="destructive"
  busy={deleteDocumentBusy}
  onConfirm={confirmDeleteDocument}
  onCancel={() => (showDeleteDocumentDialog = false)}
/>

<!-- Shared dialog for document, folder, and category entry points. -->
{#if shareTarget}
  <ShareDialog
    bind:open={showShareDialog}
    displayMode={share.displayMode}
    documentId={shareTarget.kind === "document" ? shareTarget.documentId : ""}
    documentTitle={shareTarget.kind === "document" ? shareTarget.title : ""}
    folderId={shareTarget.kind === "folder" ? shareTarget.folderId : ""}
    folderName={shareTarget.kind === "folder" ? shareTarget.name : ""}
    categoryId={shareTarget.kind === "category" ? shareTarget.categoryId : ""}
    categoryName={shareTarget.kind === "category" ? shareTarget.name : ""}
  />
{/if}

<!-- Multi-file import progress dialog overlay -->
<ImportProgress open={importOpen} items={importItems} onClose={closeImport} />
