<script lang="ts">
  interface DiffLine {
    type: "added" | "removed" | "unchanged";
    text: string;
  }

  let { oldContent, newContent }: { oldContent: string; newContent: string } = $props();

  function computeDiff(oldText: string, newText: string): DiffLine[] {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const result: DiffLine[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine === undefined) {
        result.push({ type: "added", text: newLine! });
      } else if (newLine === undefined) {
        result.push({ type: "removed", text: oldLine });
      } else if (oldLine === newLine) {
        result.push({ type: "unchanged", text: oldLine });
      } else {
        result.push({ type: "removed", text: oldLine });
        result.push({ type: "added", text: newLine });
      }
    }

    return result;
  }

  const diff = $derived(computeDiff(oldContent, newContent));
</script>

<div class="overflow-auto rounded-md border border-border font-mono text-sm">
  {#each diff as line, i (i)}
    <div
      class="px-3 py-0.5 {line.type === 'added'
        ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
        : line.type === 'removed'
          ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300'
          : 'text-foreground'}"
    >
      <span class="mr-3 inline-block w-4 text-right text-muted-foreground select-none">
        {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
      </span>
      {line.text}
    </div>
  {/each}
</div>
