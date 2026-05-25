<script lang="ts">
  import * as m from "$lib/paraglide/messages.js";

  let { documentId = "", onUpload }: {
    documentId?: string;
    onUpload?: (file: File) => void;
  } = $props();

  let dragOver = $state(false);
  let uploadedFile = $state<File | null>(null);
  let error = $state("");
  let inputRef: HTMLInputElement | undefined = $state();

  const maxSize = 10 * 1024 * 1024; // 10MB
  const accept = ".jpg,.jpeg,.png,.gif,.webp,.pdf,.md,.txt,.csv,.json";

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function validateFile(file: File): boolean {
    if (file.size > maxSize) {
      error = m.attachment_file_too_large({ size: formatSize(file.size) });
      return false;
    }
    error = "";
    return true;
  }

  function handleFiles(files: FileList | null) {
    if (!files?.[0]) return;
    const file = files[0];
    if (validateFile(file)) {
      uploadedFile = file;
      onUpload?.(file);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    handleFiles(e.dataTransfer?.files ?? null);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function openPicker() {
    inputRef?.click();
  }

  function removeFile() {
    uploadedFile = null;
    error = "";
    if (inputRef) inputRef.value = "";
  }
</script>

<div class="space-y-2">
  {#if !uploadedFile}
    <button
      onclick={openPicker}
      ondrop={handleDrop}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      class="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors
        {dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/50'}"
    >
      <svg class="h-8 w-8 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="17 8 12 3 7 8"></polyline>
        <line x1="12" y1="3" x2="12" y2="15"></line>
      </svg>
      <span class="text-sm font-medium">{m.attachment_drop_here()}</span>
      <span class="text-xs text-muted-foreground">{m.attachment_types_hint()}</span>
    </button>
    <input bind:this={inputRef} type="file" {accept} onchange={(e) => handleFiles(e.currentTarget.files)} class="hidden" />
  {:else}
    <div class="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <div class="flex h-8 w-8 items-center justify-center rounded bg-muted text-xs font-medium">
        {uploadedFile.name.split(".").pop()?.toUpperCase() ?? "FILE"}
      </div>
      <div class="flex-1 min-w-0">
        <p class="truncate text-sm font-medium">{uploadedFile.name}</p>
        <p class="text-xs text-muted-foreground">{formatSize(uploadedFile.size)}</p>
      </div>
      <button onclick={removeFile} class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={m.attachment_remove()}>
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  {/if}

  {#if error}
    <p class="text-xs text-destructive">{error}</p>
  {/if}
</div>
