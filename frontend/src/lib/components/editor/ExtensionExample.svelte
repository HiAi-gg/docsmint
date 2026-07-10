<!--
  ExtensionExample.svelte
  
  This is a reference/example component demonstrating both:
  1. Registering a custom document tab (using registerDocTab)
  2. Injecting a custom button into the TipTap Editor Toolbar (using toolbarExtensions)

  Integrators can study this file as a starting point.
-->
<script lang="ts">
import type { Editor } from "@tiptap/core";
import InfoIcon from "lucide-svelte/icons/info";
import SparklesIcon from "lucide-svelte/icons/sparkles";
import { onMount } from "svelte";
import { registerDocTab } from "$lib/stores/doc-tab-registry.svelte";
import ExtensionExamplePanel from "./ExtensionExamplePanel.svelte";
import HiAiEditor from "./HiAiEditor.svelte";

// Dummy content/document details for demonstration
let content = $state("# Hello, World!\nThis is a custom document.");
let contentJson = $state<object | undefined>(undefined);

onMount(() => {
	// Register the tab on mount
	registerDocTab({
		id: "metadata-demo",
		label: "Demo Metadata",
		component: ExtensionExamplePanel,
		order: 100,
		icon: InfoIcon,
		disabled: false,
	});
});

function handleAiFeature(editor: Editor) {
	editor
		.chain()
		.focus()
		.insertContent(" ✨ (Inserted via custom toolbar extension button) ")
		.run();
}
</script>

<div class="space-y-4">
  <div class="border rounded-lg p-4 bg-card shadow-sm">
    <h2 class="text-md font-bold mb-2">Extension System Demo</h2>
    <p class="text-xs text-muted-foreground mb-4">
      Below is the core editor wrapped with a custom toolbar button snippet.
      Check the document page tabs at the top to see the registered "Demo Metadata" tab.
    </p>

    <HiAiEditor
      content={content}
      {contentJson}
      documentId="demo-doc-id"
    >
      {#snippet toolbarExtensions({ editor })}
        {#if editor}
          <button
            type="button"
            class="toolbar-btn text-purple-600 hover:bg-purple-100/50"
            onclick={() => handleAiFeature(editor)}
            title="Insert Demo Text"
          >
            <SparklesIcon size={16} />
          </button>
        {/if}
      {/snippet}
    </HiAiEditor>
  </div>
</div>
