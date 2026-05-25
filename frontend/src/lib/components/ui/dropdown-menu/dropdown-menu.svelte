<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import type { Snippet } from "svelte";

  let {
    children,
    ...restProps
  }: DropdownMenuPrimitive.RootProps & { children?: Snippet } = $props();
</script>

<DropdownMenuPrimitive.Root {...restProps}>
  {@render children?.()}
</DropdownMenuPrimitive.Root>
