<!-- DocumentTitle.svelte — Editable title input with auto-save on blur -->
<script lang="ts">
  import * as m from "$lib/paraglide/messages.js";

  let {
    title = "",
    onUpdate = (_title: string) => {},
  }: {
    title?: string;
    onUpdate?: (title: string) => void;
  } = $props();

  let focused = $state(false);
  let localTitle = $state("");
  $effect(() => { if (!focused) localTitle = title ?? ""; });

  // Sync external title changes
  $effect(() => {
    if (!focused) {
      localTitle = title;
    }
  });

  function handleBlur() {
    focused = false;
    if (localTitle !== title) {
      onUpdate(localTitle);
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === "Escape") {
      localTitle = title;
      (e.target as HTMLInputElement).blur();
    }
  }

  function handleFocus() {
    focused = true;
  }
</script>

<input
  type="text"
  class="title-input"
  class:focused
  bind:value={localTitle}
  onfocus={handleFocus}
  onblur={handleBlur}
  onkeydown={handleKeydown}
  placeholder={m.doc_title_placeholder()}
  aria-label={m.doc_title_label()}
/>

<style>
  .title-input {
    border: none;
    border-bottom: 2px solid transparent;
    outline: none;
    background: transparent;
    font-size: 2rem;
    font-weight: 700;
    color: var(--foreground);
    width: 100%;
    padding: 0 0 4px 0;
    margin-bottom: 8px;
    transition: border-color 0.15s ease;
  }

  .title-input::placeholder {
    color: var(--muted-foreground);
  }

  .title-input.focused {
    border-bottom-color: var(--ring);
  }

  .title-input:hover:not(.focused) {
    border-bottom-color: var(--border);
  }
</style>
