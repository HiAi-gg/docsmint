<!-- EditorToolbar.svelte — Formatting toolbar for TipTap editor -->
<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import {
    Bold,
    Italic,
    Heading1,
    Heading2,
    Heading3,
    List,
    ListOrdered,
    Code2,
    Link as LinkIcon,
    Highlighter,
  } from "lucide-svelte";
  import * as m from "$lib/paraglide/messages.js";

  let {
    editor = null,
  }: {
    editor?: Editor | null;
  } = $props();

  interface ToolbarAction {
    icon: typeof Bold;
    label: string;
    isActive: () => boolean;
    onClick: () => void;
  }

  let actions = $derived.by<ToolbarAction[]>(() => {
    if (!editor) return [];
    return [
      {
        icon: Bold,
        label: m.editor_toolbar_bold(),
        isActive: () => editor!.isActive("bold"),
        onClick: () => editor!.chain().focus().toggleBold().run(),
      },
      {
        icon: Italic,
        label: m.editor_toolbar_italic(),
        isActive: () => editor!.isActive("italic"),
        onClick: () => editor!.chain().focus().toggleItalic().run(),
      },
      {
        icon: Heading1,
        label: m.editor_toolbar_heading_1(),
        isActive: () => editor!.isActive("heading", { level: 1 }),
        onClick: () =>
          editor!.chain().focus().toggleHeading({ level: 1 }).run(),
      },
      {
        icon: Heading2,
        label: m.editor_toolbar_heading_2(),
        isActive: () => editor!.isActive("heading", { level: 2 }),
        onClick: () =>
          editor!.chain().focus().toggleHeading({ level: 2 }).run(),
      },
      {
        icon: Heading3,
        label: m.editor_toolbar_heading_3(),
        isActive: () => editor!.isActive("heading", { level: 3 }),
        onClick: () =>
          editor!.chain().focus().toggleHeading({ level: 3 }).run(),
      },
      {
        icon: List,
        label: m.editor_toolbar_bullet_list(),
        isActive: () => editor!.isActive("bulletList"),
        onClick: () => editor!.chain().focus().toggleBulletList().run(),
      },
      {
        icon: ListOrdered,
        label: m.editor_toolbar_ordered_list(),
        isActive: () => editor!.isActive("orderedList"),
        onClick: () => editor!.chain().focus().toggleOrderedList().run(),
      },
      {
        icon: Code2,
        label: m.editor_toolbar_code_block(),
        isActive: () => editor!.isActive("codeBlock"),
        onClick: () => editor!.chain().focus().toggleCodeBlock().run(),
      },
      {
        icon: LinkIcon,
        label: m.editor_toolbar_link(),
        isActive: () => editor!.isActive("link"),
        onClick: () => {
          const previousUrl = editor!.getAttributes("link").href ?? "";
          const url = window.prompt(m.editor_enter_url(), previousUrl);
          if (url === null) return; // cancelled
          if (url === "") {
            editor!.chain().focus().extendMarkRange("link").unsetLink().run();
          } else {
            editor!
              .chain()
              .focus()
              .extendMarkRange("link")
              .setLink({ href: url })
              .run();
          }
        },
      },
      {
        icon: Highlighter,
        label: m.editor_toolbar_highlight(),
        isActive: () => editor!.isActive("highlight"),
        onClick: () => editor!.chain().focus().toggleHighlight().run(),
      },
    ];
  });

  function isDisabled(): boolean {
    if (!editor) return true;
    return !editor.isEditable;
  }
</script>

{#if editor}
  <div class="toolbar" role="toolbar" aria-label={m.editor_toolbar_text_formatting()}>
    {#each actions as action, i}
      {#if i === 2 || i === 5 || i === 7 || i === 8}
        <div class="toolbar-divider" aria-hidden="true"></div>
      {/if}
      <button
        class="toolbar-btn"
        class:active={action.isActive()}
        disabled={isDisabled()}
        onclick={action.onClick}
        title={action.label}
        aria-label={action.label}
        aria-pressed={action.isActive()}
        type="button"
      >
        <action.icon size={16} />
      </button>
    {/each}
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .toolbar-divider {
    width: 1px;
    height: 20px;
    background: var(--border);
    margin: 0 4px;
  }

  .toolbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .toolbar-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .toolbar-btn.active {
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .toolbar-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
