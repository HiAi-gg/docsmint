<script lang="ts">
  import { cn } from "$lib/utils";
  import type { Snippet } from "svelte";

  interface Props {
    icon?: typeof import("lucide-svelte").FileText;
    title: string;
    description?: string;
    actionLabel?: string;
    onAction?: () => void;
    class?: string;
  }

  let {
    icon: Icon,
    title,
    description,
    actionLabel,
    onAction,
    class: className,
  }: Props = $props();
</script>

<div
  class={cn(
    "flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-12 text-center",
    className,
  )}
>
  {#if Icon}
    <div class="mb-4 rounded-full bg-muted p-4">
      <Icon class="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
    </div>
  {/if}

  <h3 class="text-lg font-medium text-foreground">{title}</h3>

  {#if description}
    <p class="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
  {/if}

  {#if actionLabel && onAction}
    <button
      onclick={onAction}
      class="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
    >
      {actionLabel}
    </button>
  {/if}
</div>
