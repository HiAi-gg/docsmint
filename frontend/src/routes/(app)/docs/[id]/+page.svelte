<!-- Document editor page -->
<script lang="ts">
import { ConfirmDialog } from "@hiai-gg/hiai-ui/components/ui/confirm-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@hiai-gg/hiai-ui/components/ui/dropdown-menu";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { Packer } from "docx";
import {
	Bookmark,
	Check,
	ChevronRight,
	Code,
	Copy,
	Download,
	FileText,
	Folder,
	History,
	Loader2,
	MoreHorizontal,
	Pencil,
	Plus,
	Share2,
	Trash2,
	X,
} from "lucide-svelte";
import { marked } from "marked";
import { onDestroy, onMount } from "svelte";
import { goto } from "$app/navigation";
import { docTabRegistry } from "$lib";
import { ApiError, apiFetch } from "$lib/api/client";
import { deleteDocument, updateDocument } from "$lib/api/documents";
import { createFolder, listFolders } from "$lib/api/folders";
import {
	addTagToDocument,
	listTags,
	removeTagFromDocument,
	type Tag,
} from "$lib/api/tags";
import DocumentTitle from "$lib/components/editor/DocumentTitle.svelte";
import { customSerializer } from "$lib/components/editor/docx-serializer";
import { editorExtensions } from "$lib/components/editor/editorExtensions";
import type { EditorOutput } from "$lib/components/editor/HiAiEditor.svelte";
import HiAiEditor from "$lib/components/editor/HiAiEditor.svelte";
import MarkdownToggle from "$lib/components/editor/MarkdownToggle.svelte";
import { markdownToJson } from "$lib/components/editor/markdown";
import FolderTreeSelector from "$lib/components/FolderTreeSelector.svelte";
import SaveAsDialog from "$lib/components/SaveAsDialog.svelte";
import ShareDialog from "$lib/components/ShareDialog.svelte";
import TagCreateDialog from "$lib/components/TagCreateDialog.svelte";
import VersionHistory from "$lib/components/VersionHistory.svelte";
import * as m from "$lib/paraglide/messages.js";
import { refreshDocs, refreshTags } from "$lib/stores/tag-store.svelte";

const { data } = $props();

let title = $state("");
let content = $state("");
let contentJson = $state<object | undefined>(undefined);
let mode = $state<"wysiwyg" | "markdown">("wysiwyg");
let saveStatus = $state<"saved" | "saving" | "unsaved">("saved");
let showMenu = $state(false);
// "editor" is always the default/built-in tab; extension tabs are appended
// by registerDocTab() calls in the consuming project's layout.
let activeTab = $state("editor");
const sortedTabs = $derived(
	[...docTabRegistry].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
);
let loading = $state(true);
let error = $state<string | null>(null);
let showShareDialog = $state(false);
let showCreateTagDialog = $state(false);
let showDeleteDialog = $state(false);
let showSaveAsDialog = $state(false);
let showVersionPanel = $state(false);
let deleteBusy = $state(false);

// Tag management
type DocTag = { id: string; name: string; color: string };
let tags = $state<DocTag[]>([]);
let availableTags = $state<DocTag[]>([]);
let tagsLoading = $state(false);
let tagBusy = $state(false);

// Folder management
import type { Folder as FolderType } from "$lib/types.js";

let folders = $state<FolderType[]>([]);
let foldersLoading = $state(false);
let currentFolderId = $state<string | null>(null);
let creatingFolder = $state(false);
let newFolderName = $state("");

// Category management
import { type Category, listCategories } from "$lib/api/categories";

let categories = $state<Category[]>([]);
let categoriesLoading = $state(false);
let currentCategoryId = $state<string | null>(null);

// Consolidated sync effect — reads `data.document` once into a local alias
// so Svelte tracks the prop reference (not the writes below). Three
// fragmented effects previously each tracked `data.document` independently,
// and the cascading writes to `content` / `contentJson` (consumed by
// HiAiEditor) could trigger cross-component cycles that surfaced as
// `effect_update_depth_exceeded` on mount, route change, and markdown toggle.
//
// Rule: read `data.document` into a local `doc` const, then only read from
// that local alias inside the body. Never read the `$state` variables that
// this effect writes to — that would re-introduce a read-after-write cycle.
$effect(() => {
	const doc = data.document;
	title = doc.title;
	content = doc.content ?? "";
	contentJson = (doc.contentJson as object | null | undefined) ?? undefined;
	tags = doc.tags ?? [];
	currentFolderId = doc.folderId ?? null;
	currentCategoryId = doc.categoryId ?? null;
});

function getFolderPathName(folderId: string): string {
	const path: string[] = [];
	let current = folders.find((f) => f.id === folderId);
	const visited = new Set<string>();
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		path.unshift(current.name);
		const parentId = current.parentId;
		current = parentId ? folders.find((f) => f.id === parentId) : undefined;
	}
	return path.join(" > ");
}

const currentFolderName = $derived.by(() => {
	if (!currentFolderId) return "No folder";
	return getFolderPathName(currentFolderId) || "No folder";
});

const currentCategoryName = $derived.by(() => {
	if (!currentCategoryId) return "Uncategorized";
	const found = categories.find((c) => c.id === currentCategoryId);
	return found ? found.name : "Uncategorized";
});

function buildFolderTreeList(
	foldersList: FolderType[],
): Array<{ folder: FolderType; depth: number }> {
	const byParent = new Map<string | null, FolderType[]>();
	for (const f of foldersList) {
		const pId = f.parentId ?? null;
		if (!byParent.has(pId)) {
			byParent.set(pId, []);
		}
		byParent.get(pId)?.push(f);
	}
	for (const [_, list] of byParent.entries()) {
		list.sort((a, b) => a.name.localeCompare(b.name));
	}
	const result: Array<{ folder: FolderType; depth: number }> = [];
	function traverse(parentId: string | null, depth: number) {
		const children = byParent.get(parentId) ?? [];
		for (const child of children) {
			result.push({ folder: child, depth });
			traverse(child.id, depth + 1);
		}
	}
	traverse(null, 0);
	return result;
}

const hierarchicalFolders = $derived(buildFolderTreeList(folders));

const filteredFoldersForCategory = $derived.by(() => {
	if (!currentCategoryId) return folders;
	const rootFolders = folders.filter((f) => f.categoryId === currentCategoryId);
	const resultIds = new Set<string>(rootFolders.map((f) => f.id));
	let addedNew = true;
	while (addedNew) {
		addedNew = false;
		for (const f of folders) {
			if (f.parentId && resultIds.has(f.parentId) && !resultIds.has(f.id)) {
				resultIds.add(f.id);
				addedNew = true;
			}
		}
	}
	return folders.filter((f) => resultIds.has(f.id));
});

const assignedTagIds = $derived(new Set(tags.map((t) => t.id)));
const assignableTags = $derived(
	availableTags.filter((t) => !assignedTagIds.has(t.id)),
);

let errorTimer: ReturnType<typeof setTimeout> | null = null;

function setError(msg: string | null) {
	error = msg;
	// Auto-dismiss the banner after 5s so transient errors don't linger
	// forever. Clear any pending timer first to avoid races when several
	// errors fire in quick succession.
	if (errorTimer) {
		clearTimeout(errorTimer);
		errorTimer = null;
	}
	if (msg !== null) {
		errorTimer = setTimeout(() => {
			error = null;
			errorTimer = null;
		}, 5000);
	}
}

// Initialize after mount
onMount(async () => {
	title = data.document.title;
	content = data.document.content;
	contentJson =
		(data.document.contentJson as object | null | undefined) ?? undefined;
	loading = false;
	await Promise.all([loadCategories(), loadFolders()]);
});

onDestroy(() => {
	// Clear any pending auto-dismiss timer so we don't write to a
	// destroyed component's state if the user navigates away mid-delay.
	if (errorTimer) {
		clearTimeout(errorTimer);
		errorTimer = null;
	}
});

// Close dropdown on outside click
function handleWindowClick(e: MouseEvent) {
	if (showMenu) {
		const target = e.target as HTMLElement;
		if (!target.closest("[data-menu-container]")) {
			showMenu = false;
		}
	}
}

// Auto-save debounce for content.
// Accepts a EditorOutput (`{ markdown, json }`) from either editor
// so that edits in the raw-markdown view keep the server-side
// `contentJson` in sync — the wysiwyg editor reuses that field to avoid
// re-parsing on every load.
type ContentUpdate = EditorOutput;
let contentSaveTimer: ReturnType<typeof setTimeout> | null = null;

function debounceContentSave(update: ContentUpdate) {
	content = update.markdown;
	contentJson = update.json;
	saveStatus = "unsaved";
	if (contentSaveTimer) clearTimeout(contentSaveTimer);
	contentSaveTimer = setTimeout(async () => {
		await saveContent(update);
	}, 2000);
}

// Retries with exponential backoff: 2s, 4s, 8s (max 3 attempts).
// Used when the backend responds with 429 (rate limit) so fast typing
// doesn't surface a hard error to the user.
const RATE_LIMIT_BACKOFF_MS = [2000, 4000, 8000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveContent(update: ContentUpdate) {
	saveStatus = "saving";
	for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt++) {
		try {
			await updateDocument(data.document.id, {
				content: update.markdown,
				contentJson: update.json,
			});
			saveStatus = "saved";
			return;
		} catch (e) {
			if (
				e instanceof ApiError &&
				e.status === 429 &&
				attempt < RATE_LIMIT_BACKOFF_MS.length
			) {
				const wait = RATE_LIMIT_BACKOFF_MS[attempt];
				error = "Saving too fast. Waiting before retry...";
				await sleep(wait);
				continue;
			}
			saveStatus = "unsaved";
			error = m.doc_save_content_error();
			return;
		}
	}
}

async function handleTitleUpdate(newTitle: string) {
	title = newTitle;
	saveStatus = "saving";
	try {
		await updateDocument(data.document.id, { title: newTitle });
		saveStatus = "saved";
		refreshDocs();
	} catch (_e) {
		saveStatus = "unsaved";
		error = m.doc_save_title_error();
	}
}

async function handleDelete() {
	showMenu = false;
	showDeleteDialog = true;
}

async function confirmDelete() {
	if (deleteBusy) return;
	deleteBusy = true;
	try {
		await deleteDocument(data.document.id);
		showDeleteDialog = false;
		refreshDocs();
		goto("/");
	} catch (_e) {
		error = m.doc_delete_error();
	} finally {
		deleteBusy = false;
	}
}

function cancelDelete() {
	showDeleteDialog = false;
}

async function handleSaveAsConfirm(
	newTitle: string,
	parentId: string | null,
	categoryId: string | null,
) {
	try {
		const copy = await apiFetch<{ id: string }>(
			`/api/documents/${data.document.id}/duplicate`,
			{
				method: "POST",
			},
		);
		if (copy?.id) {
			await apiFetch(`/api/documents/${copy.id}`, {
				method: "PATCH",
				body: JSON.stringify({
					title: newTitle,
					folderId: parentId,
					categoryId: categoryId,
				}),
			});
			showSaveAsDialog = false;
			refreshDocs();
			await goto(`/docs/${copy.id}`);
		}
	} catch (err) {
		console.error("Failed to duplicate document", err);
		error = "Failed to duplicate document";
	}
}

function handleExport() {
	showMenu = false;
	const blob = new Blob([content], { type: "text/markdown" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${title || m.doc_title_placeholder()}.md`;
	a.click();
	URL.revokeObjectURL(url);
}

function handleExportDocx() {
	showMenu = false;
	try {
		let json = contentJson;
		if (!json) {
			json = markdownToJson(content || "");
		}
		const schema = getSchema(editorExtensions);
		const docNode = Node.fromJSON(schema, json);
		const wordDoc = customSerializer.serialize(docNode, {
			getImageBuffer(_src) {
				return new Uint8Array(0);
			},
			sections: [{ properties: {} }],
		});
		Packer.toBlob(wordDoc)
			.then((blob) => {
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `${title || "Untitled Document"}.docx`;
				a.click();
				URL.revokeObjectURL(url);
			})
			.catch((err) => {
				console.error("Packer failed to generate docx blob:", err);
				fallbackHtmlDocx();
			});
	} catch (err) {
		console.error("Failed to export to DOCX:", err);
		fallbackHtmlDocx();
	}

	function fallbackHtmlDocx() {
		const htmlContent = marked.parse(content || "", { async: false }) as string;
		const docHtml = `
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><title>${title || "Document"}</title>
<style>
body { font-family: Arial, sans-serif; line-height: 1.6; }
h1 { font-size: 24pt; font-weight: bold; margin-top: 12pt; margin-bottom: 6pt; }
p { margin-bottom: 6pt; }
</style>
</head>
<body>
<h1>${title || "Untitled Document"}</h1>
${htmlContent}
</body>
</html>
		`;
		const blob = new Blob([docHtml], {
			type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${title || "Untitled Document"}.docx`;
		a.click();
		URL.revokeObjectURL(url);
	}
}

function handleExportPdf() {
	showMenu = false;
	const htmlContent = marked.parse(content || "", { async: false }) as string;

	const iframe = document.createElement("iframe");
	iframe.style.position = "fixed";
	iframe.style.right = "0";
	iframe.style.bottom = "0";
	iframe.style.width = "0";
	iframe.style.height = "0";
	iframe.style.border = "0";
	document.body.appendChild(iframe);

	const doc = iframe.contentWindow?.document;
	if (!doc) return;

	doc.open();
	doc.write(`
<html>
<head>
<title>${title || "Untitled Document"}</title>
<style>
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	line-height: 1.6;
	color: #000;
	padding: 2cm;
}
h1 { font-size: 28px; font-weight: bold; margin-bottom: 20px; }
h2 { font-size: 22px; font-weight: bold; margin-top: 24px; margin-bottom: 12px; }
h3 { font-size: 18px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; }
p { margin-bottom: 12px; }
ul, ol { padding-left: 20px; margin-bottom: 12px; }
li { margin-bottom: 4px; }
blockquote {
	border-left: 3px solid #ccc;
	padding-left: 12px;
	margin: 12px 0;
	color: #666;
	font-style: italic;
}
pre {
	background: #f4f4f4;
	border: 1px solid #ddd;
	padding: 12px;
	border-radius: 4px;
	overflow-x: auto;
	font-family: monospace;
}
code {
	background: #f4f4f4;
	padding: 2px 4px;
	border-radius: 3px;
	font-family: monospace;
}
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background-color: #f4f4f4; }
img { max-width: 100%; height: auto; }
@media print {
	body { padding: 0; }
}
</style>
</head>
<body>
<h1>${title || "Untitled Document"}</h1>
${htmlContent}
\x3Cscript>
window.onload = function() {
	window.print();
	setTimeout(function() {
		window.frameElement.remove();
	}, 100);
};
\x3C/script>
</body>
</html>
	`);
	doc.close();
}

function handleShare() {
	showShareDialog = true;
}

async function loadAvailableTags() {
	if (availableTags.length > 0 || tagsLoading) return;
	tagsLoading = true;
	try {
		const all = await listTags();
		availableTags = all.map((t) => ({
			id: t.id,
			name: t.name,
			color: t.color ?? "#888",
		}));
	} catch (_e) {
		setError(m.tags_load_error());
	} finally {
		tagsLoading = false;
	}
}

async function handleAddTag(tagId: string) {
	if (tagBusy) return;
	tagBusy = true;
	const tag = availableTags.find((t) => t.id === tagId);
	try {
		await addTagToDocument(data.document.id, tagId);
		if (tag) tags = [...tags, { id: tag.id, name: tag.name, color: tag.color }];
		availableTags = availableTags.filter((t) => t.id !== tagId);
	} catch (e) {
		console.error("handleAddTag: addTagToDocument failed", e);
		setError(m.tag_add_error());
	} finally {
		tagBusy = false;
	}
}

async function handleTagCreated(newTag: Tag) {
	// Add to available tags (in case it wasn't already there) and assign
	// to this document immediately so the user doesn't need a second click.
	availableTags = [
		...availableTags.filter((t) => t.id !== newTag.id),
		{ id: newTag.id, name: newTag.name, color: newTag.color ?? "#888" },
	];
	if (!assignedTagIds.has(newTag.id)) {
		await handleAddTag(newTag.id);
	}
	// Notify other components (e.g. sidebar TagList) to reload.
	refreshTags();
}

async function handleRemoveTag(tagId: string) {
	if (tagBusy) return;
	tagBusy = true;
	const tag = tags.find((t) => t.id === tagId);
	try {
		await removeTagFromDocument(data.document.id, tagId);
		tags = tags.filter((t) => t.id !== tagId);
		if (tag) availableTags = [...availableTags, tag];
	} catch (_e) {
		setError(m.tag_remove_error());
	} finally {
		tagBusy = false;
	}
}

// --- Folder management ---
async function loadFolders() {
	if (folders.length > 0 || foldersLoading) return;
	foldersLoading = true;
	try {
		folders = await listFolders(null, true);
	} catch (_e) {
		setError(m.error_generic());
	} finally {
		foldersLoading = false;
	}
}

async function loadCategories() {
	if (categories.length > 0 || categoriesLoading) return;
	categoriesLoading = true;
	try {
		categories = await listCategories();
	} catch (_e) {
		setError(m.error_generic());
	} finally {
		categoriesLoading = false;
	}
}

async function moveToFolder(folderId: string | null) {
	try {
		const targetFolder = folderId
			? folders.find((f) => f.id === folderId)
			: null;
		const categoryId =
			(targetFolder ? targetFolder.categoryId : currentCategoryId) ?? null;

		await updateDocument(data.document.id, { folderId, categoryId });
		currentFolderId = folderId;
		currentCategoryId = categoryId;
		saveStatus = "saved";
		refreshDocs();
	} catch (_e) {
		setError(m.doc_save_content_error());
	}
}

async function moveToCategory(categoryId: string | null) {
	try {
		await updateDocument(data.document.id, { categoryId, folderId: null });
		currentCategoryId = categoryId;
		currentFolderId = null;
		saveStatus = "saved";
		refreshDocs();
	} catch (_e) {
		setError(m.doc_save_content_error());
	}
}

async function handleCreateFolder() {
	const name = newFolderName.trim();
	if (!name) return;
	try {
		const created = await createFolder({ name });
		folders = [...folders, created];
		await moveToFolder(created.id);
	} catch (_e) {
		setError(m.error_generic());
	} finally {
		creatingFolder = false;
		newFolderName = "";
	}
}

// --- Keyboard shortcuts wired by the editor ---------------------------------
//
// HiAiEditor dispatches `hiai:toggle-markdown` and `hiai:export-document`
// CustomEvents when the user presses Cmd+Shift+7 or Cmd+Shift+E. The
// shortcuts themselves are registered (and torn down) by the editor
// component, but the actual side effects — flipping `mode` and running
// the export — live here in the page so the editor stays reusable.

function handleToggleMarkdownEvent() {
	mode = mode === "wysiwyg" ? "markdown" : "wysiwyg";
}

function handleExportEvent() {
	handleExport();
}

$effect(() => {
	if (typeof window === "undefined") return;
	window.addEventListener("hiai:toggle-markdown", handleToggleMarkdownEvent);
	window.addEventListener("hiai:export-document", handleExportEvent);
	return () => {
		window.removeEventListener(
			"hiai:toggle-markdown",
			handleToggleMarkdownEvent,
		);
		window.removeEventListener("hiai:export-document", handleExportEvent);
	};
});
</script>

<svelte:window onclick={handleWindowClick} />

<svelte:head>
  <title>{m.doc_page_title({ title: title || m.doc_title_placeholder() })}</title>
</svelte:head>

{#if loading}
  <div class="loading-page">
    <div class="loading-content">
      <div class="skeleton-line skeleton-title"></div>
      <div class="skeleton-line skeleton-short"></div>
      <div class="skeleton-line skeleton-full"></div>
      <div class="skeleton-line skeleton-full"></div>
      <div class="skeleton-line skeleton-medium"></div>
    </div>
  </div>
{:else}
  <div class="editor-page">
    <!-- Header -->
    <header class="editor-header">
      <!-- Breadcrumb -->
      <nav class="breadcrumb" aria-label={m.aria_breadcrumb()}>
        <a href="/" class="breadcrumb-link">{m.breadcrumb_home()}</a>
        {#if data.document.folderName}
          <ChevronRight size={14} class="breadcrumb-sep" />
          <a href="/folders/{data.document.folderId}" class="breadcrumb-link">
            {data.document.folderName}
          </a>
        {/if}
        <ChevronRight size={14} class="breadcrumb-sep" />
        <span class="breadcrumb-current">{title || m.doc_title_placeholder()}</span>
      </nav>

      <div class="editor-actions">
        <!-- Save status -->
        <span
          class="save-status"
          class:saved={saveStatus === "saved"}
          class:saving={saveStatus === "saving"}
          class:unsaved={saveStatus === "unsaved"}
        >
          {#if saveStatus === "saved"}
            <Check size={14} /> {m.editor_status_saved()}
          {:else if saveStatus === "saving"}
            <Loader2 size={14} class="animate-spin" /> {m.editor_status_saving()}
          {:else}
            <Pencil size={14} /> {m.editor_status_unsaved()}
          {/if}
        </span>

        <!-- Mode toggle -->
        <div class="mode-toggle" role="radiogroup" aria-label={m.editor_mode_label()}>
          <button
            class="mode-btn"
            class:active={mode === "wysiwyg"}
            onclick={() => (mode = "wysiwyg")}
            title={m.editor_wysiwyg_title()}
            aria-label={m.editor_wysiwyg_mode_label()}
            role="radio"
            aria-checked={mode === "wysiwyg"}
          >
            <FileText size={16} />
          </button>
          <button
            class="mode-btn"
            class:active={mode === "markdown"}
            onclick={() => (mode = "markdown")}
            title={m.editor_markdown_title()}
            aria-label={m.editor_markdown_mode_label()}
            role="radio"
            aria-checked={mode === "markdown"}
          >
            <Code size={16} />
          </button>
        </div>

        <!-- Share -->
        <button
          class="action-btn"
          title={m.action_copy_link()}
          aria-label={m.editor_share_label()}
          onclick={handleShare}
        >
          <Share2 size={16} />
        </button>

        <!-- History -->
        <button
          class="action-btn"
          title={m.version_history_title()}
          aria-label={m.version_history_title()}
          onclick={() => (showVersionPanel = !showVersionPanel)}
          aria-pressed={showVersionPanel}
        >
          <History size={16} />
        </button>

        <!-- More menu -->
        <div class="menu-container" data-menu-container>
          <button
            class="action-btn"
            title={m.editor_more_options()}
            aria-label={m.editor_more_options()}
            onclick={() => (showMenu = !showMenu)}
          >
            <MoreHorizontal size={16} />
          </button>
          {#if showMenu}
            <div class="dropdown" role="menu">
              <button
                class="dropdown-item"
                role="menuitem"
                onclick={handleExport}
              >
                <Download size={14} /> {m.editor_export_md()}
              </button>
              <button
                class="dropdown-item"
                role="menuitem"
                onclick={handleExportDocx}
              >
                <Download size={14} /> Export DOCX
              </button>
              <button
                class="dropdown-item"
                role="menuitem"
                onclick={handleExportPdf}
              >
                <Download size={14} /> Export PDF
              </button>
              <button
                class="dropdown-item"
                role="menuitem"
                onclick={() => { showSaveAsDialog = true; showMenu = false; }}
              >
                <Copy size={14} /> Save as Copy...
              </button>
              <div class="dropdown-divider"></div>
              <button
                class="dropdown-item destructive"
                role="menuitem"
                onclick={handleDelete}
              >
                <Trash2 size={14} /> {m.action_delete()}
              </button>
            </div>
          {/if}
        </div>
      </div>
    </header>

    <!-- Error banner -->
    {#if error}
      <div class="error-banner" role="alert">
        <span>{error}</span>
        <button class="error-dismiss" onclick={() => setError(null)} aria-label={m.error_dismiss()}>
          &times;
        </button>
      </div>
    {/if}

    <!-- Extension tab bar — only rendered when external projects register tabs -->
    {#if docTabRegistry.length > 0}
      <nav class="doc-tab-bar" aria-label="Document view tabs">
        <button
          class="doc-tab"
          class:active={activeTab === "editor"}
          onclick={() => (activeTab = "editor")}
          type="button"
        >
          Editor
        </button>
        {#each sortedTabs as tab (tab.id)}
          <button
            class="doc-tab"
            class:active={activeTab === tab.id}
            disabled={tab.disabled}
            onclick={() => (activeTab = tab.id)}
            type="button"
          >
            {#if tab.icon}
              {@const Icon = tab.icon}
              <Icon size={14} class="mr-1.5 shrink-0" />
            {/if}
            {tab.label}
          </button>
        {/each}
      </nav>
    {/if}

    <!-- Editor area -->
    <div class="editor-body">
      <main class="editor-main">
        <div class="editor-main-inner">
      <!-- Editable title -->
      <DocumentTitle {title} onUpdate={handleTitleUpdate} />

      <!-- Tags -->
      <div class="tag-row">
        <!-- Category selector -->
        <DropdownMenu onOpenChange={(open) => open && void loadCategories()}>
          <DropdownMenuTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="folder-badge"
                title={currentCategoryName}
                aria-label="Change category"
              >
                <Bookmark size={14} />
                {currentCategoryName}
              </button>
            {/snippet}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {#if categoriesLoading}
              <div class="tag-empty">{m.action_loading()}</div>
            {:else}
              {#each categories as category (category.id)}
                <DropdownMenuItem onSelect={() => moveToCategory(category.id)}>
                  <Bookmark size={14} />
                  {category.name}
                  {#if currentCategoryId === category.id}
                    <Check size={12} />
                  {/if}
                </DropdownMenuItem>
              {/each}
            {/if}
            <DropdownMenuItem
              disabled={currentCategoryId === null}
              onSelect={() => moveToCategory(null)}
            >
              Uncategorize
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <!-- Folder selector: shows the current folder (or "No folder") and
             lets the user move the document, clear it to root, or create a
             new folder. -->
        <DropdownMenu onOpenChange={(open) => open && void loadFolders()}>
          <DropdownMenuTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="folder-badge"
                title={currentFolderName}
                aria-label="Change folder"
              >
                <Folder size={14} />
                {currentFolderName}
              </button>
            {/snippet}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-85 p-2">
            {#if foldersLoading}
              <div class="tag-empty">{m.action_loading()}</div>
            {:else}
              <FolderTreeSelector
                folders={filteredFoldersForCategory}
                selectedId={currentFolderId}
                onSelect={moveToFolder}
              />
            {/if}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { creatingFolder = true; }}>
              <Plus size={14} />
              New folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {#if creatingFolder}
          <span class="folder-create">
            <input
              type="text"
              bind:value={newFolderName}
              placeholder="Folder name"
              aria-label="New folder name"
              onkeydown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
                if (e.key === "Escape") { creatingFolder = false; newFolderName = ""; }
              }}
            />
            <button type="button" class="folder-create-btn" onclick={handleCreateFolder}>
              {m.action_save()}
            </button>
            <button
              type="button"
              class="folder-create-btn"
              onclick={() => { creatingFolder = false; newFolderName = ""; }}
            >
              {m.action_cancel()}
            </button>
          </span>
        {/if}
        {#each tags as tag (tag.id)}
          <span
            class="tag-badge"
            style="background-color: {tag.color}20; color: {tag.color}; border-color: {tag.color}40"
          >
            {tag.name}
            <button
              type="button"
              class="tag-remove"
              onclick={() => handleRemoveTag(tag.id)}
              disabled={tagBusy}
              aria-label={m.tag_remove_label()}
              title={m.tag_remove_label()}
            >
              <X size={12} />
            </button>
          </span>
        {/each}
        <DropdownMenu onOpenChange={(open) => open && void loadAvailableTags()}>
          <DropdownMenuTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="tag-add-btn"
                disabled={tagBusy}
                aria-label={m.tag_add_label()}
                title={m.tag_add_label()}
              >
                {#if tagsLoading}
                  <Loader2 size={12} class="animate-spin" />
                {:else}
                  <Plus size={12} />
                {/if}
                {m.tag_add_label()}
              </button>
            {/snippet}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {#if assignableTags.length === 0}
              <div class="tag-empty">
                {m.tag_no_tags_available()}
              </div>
            {:else}
              {#each assignableTags as tag (tag.id)}
                <DropdownMenuItem
                  disabled={tagBusy}
                  onSelect={() => handleAddTag(tag.id)}
                >
                  <span
                    class="tag-swatch"
                    style="background-color: {tag.color}"
                  ></span>
                  {tag.name}
                </DropdownMenuItem>
              {/each}
            {/if}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={tagBusy}
              onSelect={() => (showCreateTagDialog = true)}
            >
              <Plus class="tag-swatch" />
              {m.tags_create_new()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <!-- Editor -->
      <div class="editor-container">
        {#if activeTab === "editor"}
          {#if mode === "wysiwyg"}
            <HiAiEditor
              {content}
              {contentJson}
              onUpdate={debounceContentSave}
              editable={true}
              documentId={data.document.id}
            />
          {:else}
            <MarkdownToggle {content} onUpdate={debounceContentSave} />
          {/if}
        {:else}
          <!-- Extension tab panels registered by external projects -->
          {#each sortedTabs as tab (tab.id)}
            {#if activeTab === tab.id}
              {@const TabPanel = tab.component}
              <TabPanel
                documentId={data.document.id}
                {content}
                {contentJson}
              />
            {/if}
          {/each}
        {/if}
      </div>
        </div>
    </main>

    {#if showVersionPanel}
      <aside class="version-panel">
        <div class="version-panel-header">
          <h3>{m.version_history_title()}</h3>
          <button
            class="version-panel-close"
            onclick={() => (showVersionPanel = false)}
            aria-label={m.action_close()}
          >
            <X size={16} />
          </button>
        </div>
        <div class="version-panel-body">
          <VersionHistory
            documentId={data.document.id}
            onRestored={() => {
              showVersionPanel = false;
              window.location.reload();
            }}
          />
        </div>
      </aside>
    {/if}
    </div>

    <ShareDialog bind:open={showShareDialog} documentId={data.document.id} documentTitle={title} />
    <TagCreateDialog
      bind:open={showCreateTagDialog}
      mode="create"
      onCreated={handleTagCreated}
    />
    <ConfirmDialog
      bind:open={showDeleteDialog}
      title={m.action_delete()}
      description={m.doc_delete_confirm_hard()}
      confirmLabel={m.action_delete()}
      cancelLabel={m.action_cancel()}
      variant="destructive"
      busy={deleteBusy}
      onConfirm={confirmDelete}
      onCancel={cancelDelete}
    />
    <SaveAsDialog
      bind:open={showSaveAsDialog}
      documentId={data.document.id}
      initialTitle={title}
      initialParentId={currentFolderId}
      initialCategoryId={currentCategoryId}
      onSave={handleSaveAsConfirm}
    />
  </div>
{/if}

<style>
  /* Loading skeleton */
  .loading-page {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    min-height: 100vh;
    padding: 48px 24px;
    background: var(--background);
  }

  .loading-content {
    width: 100%;
    max-width: 860px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .skeleton-line {
    height: 20px;
    border-radius: 4px;
    background: var(--muted);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .skeleton-title {
    height: 40px;
    width: 60%;
  }

  .skeleton-short {
    width: 30%;
    height: 16px;
  }

  .skeleton-full {
    width: 100%;
  }

  .skeleton-medium {
    width: 70%;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  /* Editor page layout */
  .editor-page {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: var(--background);
  }

  .editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
    gap: 16px;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 20;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    min-width: 0;
  }

  .breadcrumb-link {
    color: var(--muted-foreground);
    text-decoration: none;
    transition: color 0.15s;
  }

  .breadcrumb-link:hover {
    color: var(--foreground);
  }

  .breadcrumb-current {
    color: var(--foreground);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  .editor-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .save-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    white-space: nowrap;
  }

  .save-status.saved {
    color: var(--muted-foreground);
  }

  .save-status.saving {
    color: var(--ring);
  }

  .save-status.unsaved {
    color: var(--destructive);
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .mode-toggle {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .mode-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: all 0.15s;
  }

  .mode-btn:hover {
    background: var(--muted);
  }

  .mode-btn.active {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: all 0.15s;
  }

  .action-btn:hover {
    background: var(--muted);
    color: var(--foreground);
  }

  .menu-container {
    position: relative;
  }

  .dropdown {
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 4px;
    min-width: 180px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    padding: 4px;
    z-index: 50;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 13px;
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.15s;
  }

  .dropdown-item:hover {
    background: var(--muted);
  }

  .dropdown-item.destructive {
    color: var(--destructive);
  }

  .dropdown-item.destructive:hover {
    background: color-mix(in srgb, var(--destructive) 10%, transparent);
  }

  .dropdown-divider {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }

  /* Error banner */
  .error-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 24px;
    background: color-mix(in srgb, var(--destructive) 10%, transparent);
    color: var(--destructive);
    font-size: 13px;
    border-bottom: 1px solid color-mix(in srgb, var(--destructive) 20%, transparent);
  }

  .error-dismiss {
    background: none;
    border: none;
    color: var(--destructive);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0 4px;
  }

  /* Extension tab bar — only visible when external projects register custom tabs */
  .doc-tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
    overflow-x: auto;
    flex-shrink: 0;
  }

  .doc-tab {
    display: inline-flex;
    align-items: center;
    padding: 8px 16px;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
    margin-bottom: -1px;
  }

  .doc-tab:hover {
    color: var(--foreground);
  }

  .doc-tab.active {
    color: var(--foreground);
    border-bottom-color: var(--primary);
  }

  .doc-tab:disabled {
    color: var(--muted-foreground);
    opacity: 0.5;
    cursor: not-allowed;
  }

  .doc-tab :global(svg) {
    margin-right: 6px;
    flex-shrink: 0;
  }

  /* Editor main area */
  .editor-body {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .editor-main {
    flex: 1;
    overflow-y: auto;
    min-width: 0;
  }

  .editor-main-inner {
    max-width: 860px;
    width: 100%;
    margin: 0 auto;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
  }

  /* Version history side panel */
  .version-panel {
    width: 320px;
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    background: var(--card);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .version-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .version-panel-header h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
  }

  .version-panel-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: all 0.15s;
  }

  .version-panel-close:hover {
    background: var(--muted);
    color: var(--foreground);
  }

  .version-panel-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .tag-row {
    display: flex;
    gap: 6px;
    margin-bottom: 16px;
    flex-wrap: wrap;
    align-items: center;
  }

  .tag-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid;
  }

  .folder-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: 9999px;
    font-size: 0.75rem;
    background: var(--accent);
    color: var(--accent-foreground);
    border: 1px solid var(--border);
    text-decoration: none;
    transition: opacity 0.15s;
  }

  .folder-badge:hover {
    opacity: 0.8;
  }

  .tag-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s, background 0.15s;
  }

  .tag-remove:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor 20%, transparent);
  }

  .tag-remove:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }

  .tag-add-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    border: 1px dashed var(--border);
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .tag-add-btn:hover {
    background: var(--muted);
    color: var(--foreground);
    border-color: var(--muted-foreground);
  }

  .tag-add-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .tag-swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .tag-empty {
    padding: 8px 12px;
    font-size: 12px;
    color: var(--muted-foreground);
  }

  .editor-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    /* `visible` (not `hidden`) so the editor toolbar popovers — emoji,
       heading, list, align — are not clipped by the container edge. */
    overflow: visible;
    min-height: 500px;
    background: var(--card);
  }

  .folder-create {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .folder-create input {
    height: 24px;
    padding: 0 8px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--background);
    color: var(--foreground);
  }

  .folder-create-btn {
    padding: 2px 8px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
  }

  .folder-create-btn:hover {
    background: var(--muted);
    color: var(--foreground);
  }

  /* Mobile responsive */
  @media (max-width: 1024px) {
    .version-panel {
      position: fixed;
      right: 0;
      top: 0;
      bottom: 0;
      width: 280px;
      z-index: 100;
      box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
    }
  }

  @media (max-width: 640px) {
    .editor-header {
      padding: 8px 16px;
    }

    .breadcrumb {
      display: none;
    }

    .editor-main-inner {
      padding: 20px 16px;
    }
  }
</style>
