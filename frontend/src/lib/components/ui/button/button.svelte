<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { buttonVariants, type ButtonProps } from "./index.js";

  let {
    ref = $bindable(null),
    class: className,
    variant = "default",
    size = "default",
    children,
    ...restProps
  }: ButtonProps = $props();
</script>

<button
  bind:this={ref}
  class={cn(buttonVariants({ variant, size }), className)}
  {...restProps}
>
  {@render children?.()}
</button>
