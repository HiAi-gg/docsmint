<script lang="ts">
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { Packer } from "docx";
import {
	ArrowLeft,
	Check,
	Copy,
	Download,
	FileText,
	Folder,
	FolderOpen,
	Lock,
} from "lucide-svelte";
import { tick, untrack } from "svelte";
import { customSerializer } from "$lib/components/editor/docx-serializer";
import { editorExtensions } from "$lib/components/editor/editorExtensions";
import { markdownToJson } from "$lib/components/editor/markdown";
import {
	hydrateSharedAttachmentImages,
	type ProseMirrorDoc,
	renderSharedDocument,
} from "$lib/components/editor/shared-document";
import ScrollToTop from "$lib/components/ScrollToTop.svelte";
import * as m from "$lib/paraglide/messages.js";
import { copyToClipboard } from "$lib/utils/clipboard";

// Initial state comes from the `load` function in `+page.ts` (runs on both
// the server during SSR and the client during hydration). This keeps
// server- and client-rendered HTML identical, which fixes the hydration
// mismatch that used to occur when fetchShare() was called at module level.
const { data } = $props();

let password = $state("");
let requiresPassword = $state(false);
let error = $state("");
let loading = $state(false);
let shareData = $state<{
	type?: string;
	data?: {
		id?: string;
		title?: string;
		content?: string;
		contentJson?: object | null;
		name?: string;
		parentId?: string | null;
		folders?: Array<{ id: string; name: string }>;
		documents?: Array<{ id: string; title: string }>;
	};
} | null>(null);
let copied = $state(false);
let copiedText = $state(false);
let verifiedPassword = $state("");

let currentView = $state<"folder" | "document">("folder");
let folderData = $state<{
	id: string;
	name: string;
	parentId: string | null;
	folders: Array<{ id: string; name: string }>;
	documents: Array<{ id: string; title: string }>;
} | null>(null);
let viewedDoc = $state<{
	id: string;
	title: string;
	content: string;
	contentJson?: object | null;
} | null>(null);
let breadcrumbs = $state<Array<{ id: string; name: string }>>([]);

$effect(() => {
	const sd = data.shareData;
	const reqPass = data.requiresPassword;
	const shareErr = data.shareError;

	untrack(() => {
		shareData = sd ?? null;
		requiresPassword = reqPass ?? false;
		error = shareErr ?? "";
		password = "";
		verifiedPassword = "";

		if (sd && sd.type === "folder" && sd.data) {
			folderData = {
				id: sd.data.id || "",
				name: sd.data.name || "",
				parentId: sd.data.parentId || null,
				folders: sd.data.folders || [],
				documents: sd.data.documents || [],
			};
			breadcrumbs = [{ id: "root", name: sd.data.name || "" }];
			currentView = "folder";
		} else if (sd && sd.type === "document" && sd.data) {
			currentView = "document";
			viewedDoc = {
				id: sd.data.id || "",
				title: sd.data.title || "",
				content: sd.data.content || "",
				contentJson: sd.data.contentJson,
			};
		}
	});
});

async function fetchShare() {
	// Guard: the load function already short-circuits for a missing token
	// and sets shareError. The user can land here via client-side
	// navigation that re-runs the form without a valid token.
	if (!data.token) {
		error = m.share_missing_token();
		return;
	}
	loading = true;
	try {
		const headers: Record<string, string> = {};
		if (password) headers["x-share-password"] = password;

		const res = await fetch(`/api/share/${data.token}`, { headers });
		const responseData = await res.json();

		if (res.status === 401) {
			// Server signals the share is password-protected when `requiresPassword`
			// is true on the response (initial load with no password supplied).
			// A wrong password comes back as 401 without that flag — we must keep
			// the password form visible and surface a retryable inline error
			// instead of replacing the whole view with a fatal error banner.
			requiresPassword = true;
			password = "";
			error = responseData.requiresPassword ? "" : m.share_password_incorrect();
			return;
		}
		if (!res.ok) {
			// Non-password failure (expired, missing share, server error). Drop
			// the password form so the user sees the banner with a way home.
			requiresPassword = false;
			password = "";
			error = responseData.error ?? m.share_load_error();
			return;
		}
		// Success — clear transient auth state so the document view renders.
		shareData = responseData;
		requiresPassword = false;
		if (password) verifiedPassword = password;
		password = "";
		error = "";

		if (shareData && shareData.type === "folder" && shareData.data) {
			folderData = {
				id: shareData.data.id || "",
				name: shareData.data.name || "",
				parentId: shareData.data.parentId || null,
				folders: shareData.data.folders || [],
				documents: shareData.data.documents || [],
			};
			breadcrumbs = [{ id: "root", name: folderData.name }];
			currentView = "folder";
		} else if (shareData && shareData.type === "document" && shareData.data) {
			currentView = "document";
			viewedDoc = {
				id: shareData.data.id || "",
				title: shareData.data.title || "",
				content: shareData.data.content || "",
				contentJson: shareData.data.contentJson,
			};
		}
	} catch (_e) {
		requiresPassword = false;
		password = "";
		error = m.share_network_error();
	} finally {
		loading = false;
	}
}

async function copyUrl() {
	await copyToClipboard(window.location.href);
	copied = true;
	setTimeout(() => {
		copied = false;
	}, 2000);
}

function getCurrentDoc() {
	if (shareData?.type === "document" && shareData.data) {
		return {
			title: shareData.data.title || "Untitled Document",
			content: shareData.data.content || "",
			contentJson: shareData.data.contentJson,
		};
	}
	if (currentView === "document" && viewedDoc) {
		return {
			title: viewedDoc.title || "Untitled Document",
			content: viewedDoc.content || "",
			contentJson: viewedDoc.contentJson,
		};
	}
	return null;
}

async function copyText() {
	const doc = getCurrentDoc();
	const text = doc?.content ?? "";
	if (!text) return;
	await copyToClipboard(text);
	copiedText = true;
	setTimeout(() => {
		copiedText = false;
	}, 2000);
}

function handleExportMd() {
	const doc = getCurrentDoc();
	if (!doc) return;
	const blob = new Blob([doc.content], { type: "text/markdown" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${doc.title}.md`;
	a.click();
	URL.revokeObjectURL(url);
}

function handleExportDocx() {
	const doc = getCurrentDoc();
	if (!doc) return;
	try {
		let json = doc.contentJson;
		if (!json) {
			json = markdownToJson(doc.content || "");
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
				a.download = `${doc.title}.docx`;
				a.click();
				URL.revokeObjectURL(url);
			})
			.catch((err) => {
				console.error("Packer failed to generate docx blob:", err);
				fallbackHtmlDocx(doc);
			});
	} catch (err) {
		console.error("Failed to export to DOCX:", err);
		fallbackHtmlDocx(doc);
	}

	function fallbackHtmlDocx(docItem: { title: string; content: string }) {
		const htmlContent = renderDocumentContent(docItem);
		const docHtml = `
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><title>${docItem.title}</title>
<style>
body { font-family: Arial, sans-serif; line-height: 1.6; }
h1 { font-size: 24pt; font-weight: bold; margin-top: 12pt; margin-bottom: 6pt; }
p { margin-bottom: 6pt; }
</style>
</head>
<body>
<h1>${docItem.title}</h1>
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
		a.download = `${docItem.title}.docx`;
		a.click();
		URL.revokeObjectURL(url);
	}
}

function handleExportPdf() {
	const doc = getCurrentDoc();
	if (!doc) return;
	const htmlContent = renderDocumentContent(doc);

	const iframe = document.createElement("iframe");
	iframe.style.position = "fixed";
	iframe.style.right = "0";
	iframe.style.bottom = "0";
	iframe.style.width = "0";
	iframe.style.height = "0";
	iframe.style.border = "0";
	document.body.appendChild(iframe);

	const iframeDoc = iframe.contentWindow?.document;
	if (!iframeDoc) return;

	iframeDoc.open();
	iframeDoc.write(`
<html>
<head>
<title>${doc.title}</title>
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
<h1>${doc.title}</h1>
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
	iframeDoc.close();
}

async function fetchShareSubResource(path: string) {
	const headers: Record<string, string> = {};
	if (verifiedPassword) headers["x-share-password"] = verifiedPassword;
	const res = await fetch(path, { headers });
	if (!res.ok) {
		const errData = await res.json().catch(() => ({}));
		throw new Error(errData.error || "Failed to load");
	}
	return res.json();
}

async function openFolder(folderId: string) {
	loading = true;
	try {
		const resData = await fetchShareSubResource(
			`/api/share/${data.token}/folders/${folderId}`,
		);
		folderData = {
			id: resData.id,
			name: resData.name,
			parentId: resData.parentId,
			folders: resData.folders || [],
			documents: resData.documents || [],
		};
		currentView = "folder";

		const existingCrumbIdx = breadcrumbs.findIndex((b) => b.id === folderId);
		if (existingCrumbIdx !== -1) {
			breadcrumbs = breadcrumbs.slice(0, existingCrumbIdx + 1);
		} else {
			breadcrumbs = [...breadcrumbs, { id: folderId, name: folderData.name }];
		}
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to open folder";
	} finally {
		loading = false;
	}
}

async function openRootFolder() {
	if (!shareData?.data) return;
	folderData = {
		id: shareData.data.id || "",
		name: shareData.data.name || "",
		parentId: shareData.data.parentId || null,
		folders: shareData.data.folders || [],
		documents: shareData.data.documents || [],
	};
	breadcrumbs = [{ id: "root", name: folderData.name }];
	currentView = "folder";
}

async function openDocument(docId: string) {
	loading = true;
	try {
		const doc = await fetchShareSubResource(
			`/api/share/${data.token}/documents/${docId}`,
		);
		viewedDoc = doc;
		currentView = "document";
	} catch (err) {
		error = err instanceof Error ? err.message : "Failed to open document";
	} finally {
		loading = false;
	}
}

function renderDocumentContent(doc: {
	content: string;
	contentJson?: object | null;
}): string {
	const docJson = doc.contentJson as { content?: unknown } | null | undefined;
	if (docJson && Array.isArray(docJson.content)) {
		return renderSharedDocument(docJson as ProseMirrorDoc);
	}
	const md = doc.content;
	if (md && md.length > 0) {
		try {
			return renderSharedDocument(markdownToJson(md) as ProseMirrorDoc);
		} catch {
			return renderSharedDocument({
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: md }],
					},
				],
			});
		}
	}
	return "";
}

function renderViewedDocContent(): string {
	return viewedDoc ? renderDocumentContent(viewedDoc) : "";
}

let sharedDocumentRoot = $state<HTMLElement | null>(null);

$effect(() => {
	const root = sharedDocumentRoot;
	const token = data.token ?? "";
	const passwordForShare = verifiedPassword;
	// Reading this value makes the effect rerun when a folder share opens a
	// different document and replaces the {@html} subtree.
	const rendered = renderViewedDocContent();
	if (!root || !token || !rendered) return;

	let cancelled = false;
	let objectUrls: string[] = [];
	void tick().then(async () => {
		try {
			const hydrated = await hydrateSharedAttachmentImages(
				root,
				token,
				passwordForShare,
			);
			if (cancelled) {
				for (const url of hydrated) URL.revokeObjectURL(url);
			} else {
				objectUrls = hydrated;
			}
		} catch (err) {
			console.error("Failed to load shared attachment", err);
		}
	});

	return () => {
		cancelled = true;
		for (const url of objectUrls) URL.revokeObjectURL(url);
	};
});
</script>

<svelte:head>
  <title>{m.share_page_title()}</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-background p-4">
  {#if loading}
    <div class="text-muted-foreground">{m.action_loading()}</div>
  {:else if shareData}
    <div class="w-full max-w-3xl space-y-6">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          {#if shareData.type === "document"}
            <FileText class="h-4 w-4" />
          {:else}
            <Folder class="h-4 w-4" />
          {/if}
          {m.share_via_label()}
        </div>
        <div class="flex items-center gap-2">
          {#if (shareData.type === "document" || currentView === "document") && getCurrentDoc()?.content}
            <button
              onclick={copyText}
              class="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              {#if copiedText}
                <Check class="h-3 w-3" /> {m.share_copied()}
              {:else}
                <Copy class="h-3 w-3" /> Copy Text
              {/if}
            </button>
            <button
              onclick={handleExportMd}
              class="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              title="Export MD"
            >
              <Download class="h-3 w-3" /> MD
            </button>
            <button
              onclick={handleExportDocx}
              class="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              title="Export DOCX"
            >
              <Download class="h-3 w-3" /> DOCX
            </button>
            <button
              onclick={handleExportPdf}
              class="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              title="Export PDF"
            >
              <Download class="h-3 w-3" /> PDF
            </button>
          {/if}
          <button
            onclick={copyUrl}
            class="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            {#if copied}
              <Check class="h-3 w-3" /> {m.share_copied()}
            {:else}
              <Copy class="h-3 w-3" /> {m.share_copy_link()}
            {/if}
          </button>
        </div>
      </div>

      {#if breadcrumbs.length > 0 && shareData?.type === "folder"}
        <nav class="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
          {#each breadcrumbs as crumb, idx}
            {#if idx > 0}
              <span class="text-muted-foreground/50">/</span>
            {/if}
            {#if idx === breadcrumbs.length - 1 && currentView === "folder"}
              <span class="font-medium text-foreground">{crumb.name}</span>
            {:else}
              <button
                type="button"
                onclick={() => {
                  if (crumb.id === "root") {
                    openRootFolder();
                  } else {
                    openFolder(crumb.id);
                  }
                }}
                class="hover:text-foreground transition-colors"
              >
                {crumb.name}
              </button>
            {/if}
          {/each}
          {#if currentView === "document"}
            <span class="text-muted-foreground/50">/</span>
            <span class="font-medium text-foreground">{viewedDoc?.title}</span>
          {/if}
        </nav>
      {/if}

      {#if currentView === "document" && viewedDoc}
        <article class="rounded-lg border border-border bg-card p-8 shadow-sm">
          <h1 class="mb-6 flex items-center gap-2.5 text-3xl font-bold tracking-tight">
            {#if shareData.type === "folder"}
              <button
                type="button"
                onclick={() => {
                  currentView = "folder";
                }}
                class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                title="Back to folder"
              >
                <ArrowLeft class="h-5 w-5" />
              </button>
            {/if}
            <span>{viewedDoc.title}</span>
          </h1>
          {#if renderViewedDocContent()}
            <div class="shared-doc-body" bind:this={sharedDocumentRoot}>
              {@html renderViewedDocContent()}
            </div>
          {:else}
            <p class="text-muted-foreground">{m.share_empty_document()}</p>
          {/if}
        </article>
      {:else if currentView === "folder" && folderData}
        <div class="rounded-lg border border-border bg-card p-6 shadow-sm">
          
          {#if (!folderData.folders || folderData.folders.length === 0) && (!folderData.documents || folderData.documents.length === 0)}
            <p class="text-muted-foreground">{m.share_folder_empty()}</p>
          {:else}
            <div class="space-y-6">
              <!-- Subfolders -->
              {#if folderData.folders && folderData.folders.length > 0}
                <div class="space-y-2">
                  <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{m.nav_folders()}</h3>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {#each folderData.folders as sub}
                      <button
                        type="button"
                        onclick={() => openFolder(sub.id)}
                        class="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <FolderOpen class="h-4 w-4 shrink-0 text-primary" />
                        <span class="text-sm font-medium truncate">{sub.name}</span>
                      </button>
                    {/each}
                  </div>
                </div>
              {/if}

              <!-- Documents -->
              {#if folderData.documents && folderData.documents.length > 0}
                <div class="space-y-2">
                  <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{m.nav_documents()}</h3>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {#each folderData.documents as doc}
                      <button
                        type="button"
                        onclick={() => openDocument(doc.id)}
                        class="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span class="text-sm font-medium truncate">{doc.title}</span>
                      </button>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else if requiresPassword}
    <form
      onsubmit={(e) => { e.preventDefault(); fetchShare(); }}
      class="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
    >
      <div class="flex items-center gap-2 text-lg font-semibold">
        <Lock class="h-5 w-5" />
        {m.share_password_required()}
      </div>
      {#if error}
        <div
          role="alert"
          class="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      {/if}
      <input
        type="password"
        bind:value={password}
        placeholder={m.share_password_placeholder()}
        class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <button
        type="submit"
        class="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
      >
        {m.share_access_button()}
      </button>
    </form>
  {:else if error}
    <div class="w-full max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
      <p class="text-lg font-medium text-destructive">{error}</p>
      <a href="/" class="mt-4 inline-block text-sm text-primary underline">{m.share_go_home()}</a>
    </div>
  {/if}
</div>

<ScrollToTop />

<style>
  /* Shared document body — minimal styles for the markdown/JSON HTML output
     rendered via {@html}. The `prose` class from @tailwindcss/typography
     is not installed in this project, so we provide the essentials. */
  .shared-doc-body {
    color: var(--foreground);
    line-height: 1.7;
    font-size: 1rem;
    word-wrap: break-word;
  }
  .shared-doc-body :global(h1) {
    font-size: 1.875rem;
    font-weight: 700;
    margin: 1.5rem 0 0.75rem;
    letter-spacing: -0.02em;
  }
  .shared-doc-body :global(h2) {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 1.25rem 0 0.5rem;
  }
  .shared-doc-body :global(h3) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 1rem 0 0.5rem;
  }
  .shared-doc-body :global(p) {
    margin: 0.5rem 0;
  }
  /* Lists. Tailwind v4 preflight sets `list-style: none` on `ol, ul, menu`;
     the `ul:not([data-type="taskList"])` form below lifts our specificity
     above that reset so the disc / decimal markers reappear in the share
     view. Mirrors the rules in HiAiEditor.svelte so the editor and the
     share view render the same list shapes. */
  .shared-doc-body :global(ul:not([data-type="taskList"])),
  .shared-doc-body :global(ol) {
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .shared-doc-body :global(ul:not([data-type="taskList"])) {
    list-style-type: disc;
  }
  .shared-doc-body :global(ol) {
    list-style-type: decimal;
  }
  .shared-doc-body :global(li) {
    margin: 0.25rem 0;
    display: list-item;
  }
  /* Task lists — no bullet, checkbox + content laid out in a row. */
  .shared-doc-body :global(ul[data-type="taskList"]) {
    list-style: none;
    padding-left: 0.25rem;
  }
  .shared-doc-body :global(ul[data-type="taskList"] li) {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .shared-doc-body :global(ul[data-type="taskList"] li > label) {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 1.7em;
    margin: 0;
  }
  .shared-doc-body :global(ul[data-type="taskList"] li > div > p) {
    margin: 0;
  }
  .shared-doc-body :global(ul[data-type="taskList"] input[type="checkbox"]) {
    accent-color: var(--primary);
  }
  .shared-doc-body :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 1rem;
    margin: 0.75rem 0;
    color: var(--muted-foreground);
    font-style: italic;
  }
  .shared-doc-body :global(code) {
    background: var(--muted);
    padding: 0.125rem 0.375rem;
    border-radius: 4px;
    font-size: 0.875em;
    font-family: "Fira Code", "Consolas", monospace;
  }
  .shared-doc-body :global(pre) {
    background: var(--muted);
    color: var(--foreground);
    border: 1px solid var(--border);
    padding: 1rem;
    border-radius: 8px;
    font-family: "Fira Code", "Consolas", monospace;
    font-size: 0.875rem;
    line-height: 1.6;
    overflow-x: auto;
    margin: 0.75rem 0;
  }
  .shared-doc-body :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
    color: inherit;
  }
  .shared-doc-body :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1.5rem 0;
  }
  .shared-doc-body :global(a) {
    color: var(--primary);
    text-decoration: underline;
  }
  .shared-doc-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 0.75rem 0;
    display: block;
  }
  .shared-doc-body :global(mark) {
    background-color: var(--highlight-default, #fde68a);
    border-radius: 2px;
    padding: 0 2px;
  }
  .shared-doc-body :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.75rem 0;
  }
  .shared-doc-body :global(th),
  .shared-doc-body :global(td) {
    border: 1px solid var(--border);
    padding: 0.4rem 0.6rem;
    text-align: left;
    vertical-align: top;
  }
  .shared-doc-body :global(th) {
    background: var(--muted);
    font-weight: 600;
  }
</style>
