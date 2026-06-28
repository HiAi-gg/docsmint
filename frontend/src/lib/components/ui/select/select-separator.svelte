<script lang="ts">
import { cn } from "$lib/utils";

let {
	ref = $bindable(null),
	class: className,
	...restProps
}: {
	ref?: HTMLElement | null;
	class?: string;
	[key: string]: unknown;
} = $props();
</script>

<div
  bind:this={ref}
  class={cn("-mx-1 my-1 h-px bg-muted", className)}
  role="separator"
  {...restProps}
></div>
