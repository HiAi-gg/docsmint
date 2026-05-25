<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";

  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...restProps}>
  {@render children?.()}
</div>
