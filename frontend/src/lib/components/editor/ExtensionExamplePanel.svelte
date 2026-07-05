<!--
  ExtensionExamplePanel.svelte
  
  This is a reference/example panel component demonstrating how to build
  a custom tab panel for document page extensions in hiai-docs.
-->
<script lang="ts">
import InfoIcon from "lucide-svelte/icons/info";
import type { DocTabPanelProps } from "../..";

// Destructure the stable props passed reactively by the document page:
const { documentId, content }: DocTabPanelProps = $props();
</script>

<div class="p-6 max-w-xl mx-auto border rounded bg-muted/20 my-4">
  <h3 class="text-lg font-semibold flex items-center gap-2">
    <InfoIcon size={18} class="text-primary" />
    Document Metadata Extension
  </h3>
  <p class="text-sm text-muted-foreground mt-1">
    This is a custom tab panel registered from the outside via <code>registerDocTab</code>.
  </p>
  <div class="mt-4 space-y-2 text-xs">
    <div><strong>Document ID:</strong> {documentId}</div>
    <div><strong>Content Length:</strong> {content.length} characters</div>
  </div>
</div>
