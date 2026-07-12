# Extending hiai-docs

hiai-docs exposes clean, open-source extension points for external projects that consume it as a dependency or Git submodule (e.g. commercial forks, admin dashboards, or custom portals). 

These extension points allow you to customize the core editor toolbar and add custom tabs to the main document page without altering any core files.

## UI invariants

Extensions must use the existing hiai-docs design tokens and component
primitives rather than introduce a parallel theme. Keep editor controls compact,
keyboard accessible, and usable on mobile. Preserve both the Markdown source and
the structured TipTap representation when adding editor nodes; public sharing
and export renderers must receive an equivalent representation. Product-specific
features belong in extension slots or consumer code, not private core imports.

---

## 1. Extension Points Overview

| Extension Point | API / Mechanism | Location / Component | Description |
|---|---|---|---|
| **Editor Toolbar** | `toolbarExtensions` Snippet Prop | `HiAiEditor` / `EditorToolbar` | Inject custom buttons, menus (e.g., AI tools) directly into the toolbar. |
| **Document Tabs** | `registerDocTab()` function & `docTabRegistry` | `src/lib/stores/doc-tab-registry.svelte.ts` | Append custom tabs (e.g., HTML preview, audits) next to the built-in Editor tab. |

---

## 2. Editor Toolbar Extension

You can inject custom buttons or dropdown menus into the TipTap formatting toolbar using Svelte 5 snippets. Pass the `toolbarExtensions` snippet to the `<HiAiEditor>` component. The snippet receives the live TipTap `editor` instance.

### Example: Adding an AI Writing Assistant Button

In your external project's document page or editor wrapper:

```svelte
<script lang="ts">
  import HiAiEditor from "@hiai-docs/frontend/src/lib/components/editor/HiAiEditor.svelte";
  import SparklesIcon from "lucide-svelte/icons/sparkles";
  import type { Editor } from "@tiptap/core";

  let content = $state("Initial document content...");

  function insertAiDraft(editor: Editor) {
    if (!editor) return;
    // Insert text at the current cursor selection
    editor.chain().focus().insertContent("<p>✨ AI generated suggestion...</p>").run();
  }
</script>

<HiAiEditor bind:content={content} documentId="doc-123">
  {#snippet toolbarExtensions({ editor })}
    {#if editor}
      <button
        type="button"
        class="toolbar-btn text-purple-600 hover:bg-purple-50"
        onclick={() => insertAiDraft(editor)}
        title="AI Autocomplete"
      >
        <SparklesIcon size={16} />
      </button>
    {/if}
  {#/snippet}
</HiAiEditor>
```

---

## 3. Document Tab Extension

You can add completely new view tabs (such as an HTML preview, PDF export tab, or version audit view) next to the standard **Editor** tab on the document page.

To register a tab, import `registerDocTab` from the public barrel package/path and call it (typically in your main layout or router initialization).

### Step 1: Define Your Custom Tab Panel Component

Create a Svelte component that conforms to the `DocTabPanelProps` interface:

```svelte
<!-- HtmlPreviewPanel.svelte -->
<script lang="ts">
  import type { DocTabPanelProps } from "$lib";
  import { marked } from "marked";

  // Destructure public stable props:
  const { documentId, content, contentJson }: DocTabPanelProps = $props();

  // Dynamically compile markdown content on the fly
  const html = $derived(marked(content));
</script>

<div class="p-6 max-w-3xl mx-auto prose">
  <h3>HTML Live Preview (ID: {documentId})</h3>
  <hr />
  {@html html}
</div>
```

### Step 2: Register the Tab in Your Layout

Call `registerDocTab()` to append your tab to the registry:

```svelte
<!-- +layout.svelte in your consumer project -->
<script lang="ts">
  import { registerDocTab } from "@hiai-docs/frontend/src/lib";
  import HtmlPreviewPanel from "./HtmlPreviewPanel.svelte";
  import CodeIcon from "lucide-svelte/icons/code";

  // Register once at layout level (idempotent, safe across HMR updates)
  registerDocTab({
    id: "html-preview",
    label: "HTML View",
    component: HtmlPreviewPanel,
    order: 10,               // Lower values render first; omitted order behaves like 0
    icon: CodeIcon,          // Optional Svelte icon component (Lucide or custom)
    disabled: false,         // Optional flag to disable the tab
  });
</script>

<slot />
```

---

## 4. Tab Extension API Reference

### `DocTabDefinition` Interface

```ts
import type { Component, ComponentType, SvelteComponent } from "svelte";
import type { IconProps } from "lucide-svelte";

export interface DocTabDefinition {
  /** Unique stable ID. Used in URL routing or state and must not change. */
  id: string;
  
  /** Label text displayed on the tab button. */
  label: string;
  
  /** Svelte component rendered when active. Receives DocTabPanelProps. */
  component: Component<DocTabPanelProps>;
  
  /** Optional sorting order. Smaller values render first. Default is 0 when omitted. */
  order?: number;
  
  /** Optional Svelte icon component. */
  icon?: ComponentType<SvelteComponent<IconProps>>;
  
  /** Optional flag to render the tab button in a greyed-out, disabled state. */
  disabled?: boolean;
}
```

### `DocTabPanelProps` Interface

Every component rendered inside an extension tab receives these props reactively:

```ts
export interface DocTabPanelProps {
  /** The server-assigned document ID. */
  documentId: string;
  
  /** Current markdown content string. */
  content: string;
  
  /** Current ProseMirror JSON representation of the content. */
  contentJson: object | undefined;
}
```

---

## 5. Rules for Integrators & Submodule Consumers

To keep your extension code maintainable, follow these guidelines:

1. **Never Modify Core Files Directly**:
   Always keep your component definitions, style sheets, and asset files in your consumer/fork repository. Only use the public exports and registry stores provided by `hiai-docs`.

2. **Ensure Idempotency**:
   Tab registration occurs on layout initialization or component mount. `registerDocTab()` protects against duplicate registrations by verifying the tab `id` is unique. Do not attempt to bypass this.

3. **Keep Extension Components Self-Contained**:
   Avoid importing internal non-public modules from `hiai-docs` (e.g. internal database utilities, private endpoints, or local stores) as they may change without notice. Rely only on properties passed to you via `DocTabPanelProps`.

4. **Stability Guarantees**:
   The extension registry interfaces (`DocTabDefinition`, `DocTabPanelProps`) and exports (`registerDocTab`, `docTabRegistry`) are considered stable APIs. Any breaking changes will result in a major version bump of the repository.
