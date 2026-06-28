<!-- CreateSnapshotDialog.svelte — Modal that captures a named snapshot of
     the current document state. The label is required; description is
     optional free-form text. On success the dialog closes and the
     `onSuccess` callback fires so the parent can refresh the version
     list or re-render the editor. -->
<script lang="ts">
import { Loader2 } from "lucide-svelte";
import { ApiError, apiFetch } from "$lib/api/client";
import { Button } from "$lib/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import { Textarea } from "$lib/components/ui/textarea";
import * as m from "$lib/paraglide/messages.js";

interface SnapshotResponse {
	id: string;
	documentId: string;
	label: string;
	description: string | null;
	isSnapshot: boolean;
	createdAt: string;
}

const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

let {
	open = $bindable(false),
	documentId,
	onSuccess,
}: {
	open?: boolean;
	documentId: string;
	onSuccess?: () => void;
} = $props();

let label = $state("");
let description = $state("");
let labelError = $state<string | null>(null);
let submitError = $state<string | null>(null);
let submitting = $state(false);

function reset() {
	label = "";
	description = "";
	labelError = null;
	submitError = null;
	submitting = false;
}

function close() {
	if (submitting) return;
	open = false;
	reset();
}

function handleOpenChange(next: boolean) {
	if (next) {
		reset();
	} else if (!submitting) {
		open = false;
		reset();
	}
}

function handleSubmit(e?: Event) {
	e?.preventDefault();
	if (submitting) return;

	const trimmedLabel = label.trim();
	if (trimmedLabel.length === 0) {
		labelError = m.version_snapshot_label();
		return;
	}
	if (trimmedLabel.length > MAX_LABEL_LENGTH) {
		labelError = m.error_validation();
		return;
	}

	const trimmedDescription = description.trim();
	if (trimmedDescription.length > MAX_DESCRIPTION_LENGTH) {
		submitError = m.error_validation();
		return;
	}

	void doCreate(trimmedLabel, trimmedDescription);
}

async function doCreate(trimmedLabel: string, trimmedDescription: string) {
	submitting = true;
	labelError = null;
	submitError = null;
	try {
		const body: { label: string; description?: string } = {
			label: trimmedLabel,
		};
		if (trimmedDescription.length > 0) {
			body.description = trimmedDescription;
		}
		await apiFetch<SnapshotResponse>(`/api/documents/${documentId}/versions`, {
			method: "POST",
			body: JSON.stringify(body),
		});
		onSuccess?.();
		open = false;
		reset();
	} catch (e) {
		if (e instanceof ApiError) {
			submitError = `${m.version_restore_failed()}: ${e.message}`;
		} else {
			submitError = e instanceof Error ? e.message : m.error_server();
		}
		console.error("CreateSnapshotDialog: failed", e);
	} finally {
		submitting = false;
	}
}

function handleLabelKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		handleSubmit();
	}
}
</script>

<Dialog bind:open onOpenChange={handleOpenChange}>
	<DialogHeader>
		<DialogTitle>{m.version_snapshot_dialog_title()}</DialogTitle>
		<DialogDescription>
			{m.version_snapshot_dialog_description()}
		</DialogDescription>
	</DialogHeader>

	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSubmit();
		}}
		class="space-y-4"
	>
		<div class="space-y-2">
			<label for="snapshot-label" class="text-sm font-medium">
				{m.version_snapshot_label()}
			</label>
			<Input
				id="snapshot-label"
				name="label"
				type="text"
				bind:value={label}
				placeholder={m.version_snapshot_label_placeholder()}
				maxlength={MAX_LABEL_LENGTH}
				required
				disabled={submitting}
				aria-invalid={labelError ? "true" : undefined}
				aria-describedby={labelError ? "snapshot-label-error" : undefined}
				autocomplete="off"
				onkeydown={handleLabelKeydown}
			/>
			{#if labelError}
				<p id="snapshot-label-error" class="text-xs text-destructive">
					{labelError}
				</p>
			{/if}
		</div>

		<div class="space-y-2">
			<label for="snapshot-description" class="text-sm font-medium">
				{m.version_snapshot_description()}
			</label>
			<Textarea
				id="snapshot-description"
				name="description"
				bind:value={description}
				placeholder={m.version_snapshot_description_placeholder()}
				maxlength={MAX_DESCRIPTION_LENGTH}
				rows={3}
				disabled={submitting}
			/>
		</div>

		{#if submitError}
			<p class="text-xs text-destructive" role="alert">{submitError}</p>
		{/if}
	</form>

	<DialogFooter>
		<Button
			variant="outline"
			type="button"
			onclick={close}
			disabled={submitting}
		>
			{m.action_cancel()}
		</Button>
		<Button
			type="button"
			onclick={() => handleSubmit()}
			disabled={submitting || label.trim().length === 0}
		>
			{#if submitting}
				<Loader2 class="mr-1 size-4 animate-spin" />
				{m.version_snapshot_creating()}
			{:else}
				{m.version_snapshot_create()}
			{/if}
		</Button>
	</DialogFooter>
</Dialog>
