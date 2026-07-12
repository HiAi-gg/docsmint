<!-- DeleteDialog.svelte — accessible destructive confirmation with a
     branded completion state. The target remains visible after deletion so
     the user can verify exactly what was removed before dismissing. -->
<script lang="ts">
import { Button } from "@hiai-gg/hiai-ui/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@hiai-gg/hiai-ui/components/ui/dialog";
import { CheckCircle2, Loader2 } from "lucide-svelte";

let {
	open = $bindable(false),
	targetName,
	title,
	description,
	successTitle,
	successDescription,
	confirmLabel = "Delete",
	cancelLabel = "Cancel",
	doneLabel = "Done",
	errorFallback = "Failed to delete",
	onConfirm,
	onCancel,
}: {
	open?: boolean;
	targetName: string;
	title: string;
	description: string;
	successTitle: string;
	successDescription: string;
	confirmLabel?: string;
	cancelLabel?: string;
	doneLabel?: string;
	errorFallback?: string;
	onConfirm?: () => Promise<void> | void;
	onCancel?: () => void;
} = $props();

let busy = $state(false);
let success = $state(false);
let error = $state<string | null>(null);

// A new open starts a fresh confirmation. Keep the success state while the
// dialog remains open so the completion feedback cannot disappear before
// the user has had a chance to read it.
$effect(() => {
	if (!open) {
		success = false;
		error = null;
	}
});

async function handleConfirm() {
	if (busy || success) return;
	busy = true;
	error = null;
	try {
		await onConfirm?.();
		success = true;
	} catch (cause) {
		console.error("DeleteDialog: delete failed", cause);
		error =
			cause instanceof Error && cause.message.trim()
				? cause.message
				: errorFallback;
	} finally {
		busy = false;
	}
}

function handleCancel() {
	if (busy) return;
	open = false;
	onCancel?.();
}

function handleOpenChange(next: boolean) {
	// bits-ui updates a bindable `open` value before invoking this callback.
	// Restore it while a destructive request is in flight so Escape,
	// backdrop clicks, and dialog teardown cannot hide the operation or its
	// eventual success acknowledgement.
	if (!next && busy) {
		open = true;
		return;
	}
	if (!next) handleCancel();
}
</script>

<Dialog
	bind:open
	onOpenChange={handleOpenChange}
>
	{#if success}
		<DialogHeader>
			<DialogTitle>{successTitle}</DialogTitle>
			<DialogDescription>
				<span class="font-medium text-foreground">“{targetName}”</span>
				{successDescription}
			</DialogDescription>
		</DialogHeader>
		<div
			class="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/10 p-4"
			role="status"
			aria-live="polite"
		>
			<CheckCircle2 class="mt-0.5 size-5 shrink-0 text-primary" />
			<p class="text-sm text-muted-foreground">
				<span class="font-medium text-foreground">“{targetName}”</span>
				{successDescription}
			</p>
		</div>
	{:else}
		<DialogHeader>
			<DialogTitle>{title}</DialogTitle>
			<DialogDescription>
				Delete <span class="font-medium text-foreground">“{targetName}”</span>?
				{description}
			</DialogDescription>
		</DialogHeader>
		{#if error}
			<p class="text-sm text-destructive" role="alert">{error}</p>
		{/if}
	{/if}

	<DialogFooter>
		{#if !success}
			<Button variant="outline" type="button" onclick={handleCancel} disabled={busy}>
				{cancelLabel}
			</Button>
		{/if}
		<Button
			type="button"
			variant={success ? "default" : "destructive"}
			onclick={success ? handleCancel : handleConfirm}
			disabled={busy}
		>
			{#if busy}
				<Loader2 class="mr-1 size-4 animate-spin" />
			{/if}
			{success ? doneLabel : confirmLabel}
		</Button>
	</DialogFooter>
</Dialog>
