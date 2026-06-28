<script lang="ts">
import { cn } from "$lib/utils";
import { type ButtonProps, buttonVariants } from "./index.js";

let {
	class: className,
	variant = "default",
	size = "default",
	ref = $bindable(null),
	href = undefined,
	children,
	...restProps
}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		{href}
		class={cn(buttonVariants({ variant, size }), className)}
		{...restProps as Record<string, unknown>}
	>
		{#if children}
			{@render children()}
		{/if}
	</a>
{:else}
	<button
		bind:this={ref}
		class={cn(buttonVariants({ variant, size }), className)}
		{...restProps}
	>
		{#if children}
			{@render children()}
		{/if}
	</button>
{/if}
