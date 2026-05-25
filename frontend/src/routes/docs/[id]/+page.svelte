<!-- Document editor page -->
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import TipexEditor from "$lib/components/editor/TipexEditor.svelte";
  import MarkdownToggle from "$lib/components/editor/MarkdownToggle.svelte";
  import DocumentTitle from "$lib/components/editor/DocumentTitle.svelte";
  import { updateDocument, deleteDocument } from "$lib/api/documents";
  import * as m from "$lib/paraglide/messages.js";
  import {
    FileText,
    Code,
    ChevronRight,
    Share2,
    MoreHorizontal,
    Download,
    Trash2,
    Check,
    Loader2,
    Pencil,
  } from "lucide-svelte";

  let { data } = $props();

  let title = $state("");
  let content = $state("");
  $effect(() => {
    title = data.document.title;
    content = data.document.content ?? "";
  });
  let mode = $state<"wysiwyg" | "markdown">("wysiwyg");
  let saveStatus = $state<"saved" | "saving" | "unsaved">("saved");
  let showMenu = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Initialize after mount
  onMount(() => {
    title = data.document.title;
    content = data.document.content;
    loading = false;
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

  // Auto-save debounce for content
  let contentSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function debounceContentSave(newContent: string) {
    content = newContent;
    saveStatus = "unsaved";
    if (contentSaveTimer) clearTimeout(contentSaveTimer);
    contentSaveTimer = setTimeout(async () => {
      await saveContent(newContent);
    }, 1000);
  }

  async function saveContent(newContent: string) {
    saveStatus = "saving";
    try {
      await updateDocument(data.document.id, { content: newContent });
      saveStatus = "saved";
    } catch (e) {
      saveStatus = "unsaved";
      error = m.doc_save_content_error();
      console.error("Save content failed:", e);
    }
  }

  async function handleTitleUpdate(newTitle: string) {
    title = newTitle;
    saveStatus = "saving";
    try {
      await updateDocument(data.document.id, { title: newTitle });
      saveStatus = "saved";
    } catch (e) {
      saveStatus = "unsaved";
      error = m.doc_save_title_error();
      console.error("Save title failed:", e);
    }
  }

  async function handleDelete() {
    showMenu = false;
    if (!window.confirm(m.doc_delete_confirm_hard())) return;
    try {
      await deleteDocument(data.document.id);
      goto("/");
    } catch (e) {
      error = m.doc_delete_error();
      console.error("Delete failed:", e);
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

  function handleShare() {
    // Placeholder: copy current URL to clipboard
    navigator.clipboard.writeText(window.location.href).then(() => {
      // Could show a toast here
    });
  }
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
        <button class="error-dismiss" onclick={() => (error = null)} aria-label={m.error_dismiss()}>
          &times;
        </button>
      </div>
    {/if}

    <!-- Editor area -->
    <main class="editor-main">
      <!-- Editable title -->
      <DocumentTitle {title} onUpdate={handleTitleUpdate} />

      <!-- Tags -->
      {#if (data.document.tags?.length ?? 0) > 0}
        <div class="tag-row">
          {#each data.document.tags as tag (tag.name)}
            <span
              class="tag-badge"
              style="background-color: {tag.color}20; color: {tag.color}; border-color: {tag.color}40"
            >
              {tag.name}
            </span>
          {/each}
        </div>
      {/if}

      <!-- Editor -->
      <div class="editor-container">
        {#if mode === "wysiwyg"}
          <TipexEditor {content} onUpdate={debounceContentSave} editable={true} />
        {:else}
          <MarkdownToggle {content} onUpdate={debounceContentSave} />
        {/if}
      </div>
    </main>
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
    color: oklch(0.75 0.15 75);
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

  /* Editor main area */
  .editor-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    max-width: 860px;
    width: 100%;
    margin: 0 auto;
    padding: 32px 24px;
  }

  .tag-row {
    display: flex;
    gap: 6px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .tag-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid;
  }

  .editor-container {
    flex: 1;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    min-height: 500px;
    background: var(--card);
  }

  /* Mobile responsive */
  @media (max-width: 640px) {
    .editor-header {
      padding: 8px 16px;
    }

    .breadcrumb {
      display: none;
    }

    .editor-main {
      padding: 20px 16px;
    }

  }
</style>
