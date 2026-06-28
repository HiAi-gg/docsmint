<!-- ConfirmDialog.svelte — Generic confirmation dialog used in place of
     window.confirm() so destructive actions get styled, accessible UI. -->
<script lang="ts">
import { Loader2 } from "lucide-svelte";
import { Button } from "$lib/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import * as m from "$lib/paraglide/messages.js";

let {
	open = $bindable(false),
	title,
	description,
	confirmLabel,
	cancelLabel,
	variant = "default",
	busy = false,
	onConfirm,
	onCancel,
}: {
	open?: boolean;
	title: string;
	description?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "default" | "destructive";
	busy?: boolean;
	onConfirm?: () => void;
	onCancel?: () => void;
} = $props();

function close() {
	if (busy) return;
	open = false;
	onCancel?.();
}

function handleConfirm() {
	onConfirm?.();
}
</script>

<Dialog
	bind:open
	onOpenChange={(next) => {
		if (!next) onCancel?.();
	}}
>
	<DialogHeader>
		<DialogTitle>{title}</DialogTitle>
		{#if description}
			<DialogDescription>{description}</DialogDescription>
		{/if}
	</DialogHeader>
	<DialogFooter>
		<Button variant="outline" type="button" onclick={close} disabled={busy}>
			{cancelLabel ?? m.action_cancel()}
		</Button>
		<Button
			type="button"
			variant={variant === "destructive" ? "destructive" : "default"}
			onclick={handleConfirm}
			disabled={busy}
		>
			{#if busy}
				<Loader2 class="mr-1 size-4 animate-spin" />
			{/if}
			{confirmLabel ?? m.action_confirm()}
		</Button>
	</DialogFooter>
</Dialog>
