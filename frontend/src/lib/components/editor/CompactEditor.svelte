<script lang="ts">
import type { CollaborationSession } from "$lib/collaboration";
import HiAiEditor, { type EditorOutput } from "./HiAiEditor.svelte";

let {
	content = "",
	contentJson,
	placeholder,
	onUpdate = (_output: EditorOutput) => {},
	editable = true,
	collaboration = null,
	documentId = "",
	documentUpdatedAt = "",
}: {
	content?: string;
	contentJson?: object;
	placeholder?: string;
	onUpdate?: (output: EditorOutput) => void;
	editable?: boolean;
	collaboration?: CollaborationSession | null;
	documentId?: string;
	documentUpdatedAt?: string;
} = $props();
</script>

<HiAiEditor
  {content}
  {contentJson}
  {placeholder}
  {onUpdate}
  {editable}
  {collaboration}
  {documentId}
  {documentUpdatedAt}
  minimalToolbar={true}
/>
