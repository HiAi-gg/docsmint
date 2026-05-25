<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
  } = $props();

  function close() {
    open = false;
    onOpenChange?.(false);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  $effect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center"
    onkeydown={handleKeydown}
    onclick={handleBackdropClick}
  >
    <div class="fixed inset-0 bg-black/80" aria-hidden="true"></div>
    <div
      class="relative z-50 grid w-full max-w-lg gap-4 border bg-background p-6 shadow-lg sm:rounded-lg"
      role="dialog"
      aria-modal="true"
    >
      {@render children?.()}
    </div>
  </div>
{/if}
