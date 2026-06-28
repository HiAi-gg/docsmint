<!-- TagCreateDialog.svelte — Create or edit a tag (name + color). -->
<script lang="ts">
import { Loader2 } from "lucide-svelte";
import {
	createTag,
	createTagInputSchema,
	type Tag,
	updateTag,
	updateTagInputSchema,
} from "$lib/api/tags";
import { Button } from "$lib/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
import * as m from "$lib/paraglide/messages.js";
import { cn } from "$lib/utils";

// Curated palette — common tag colors that read well on light & dark surfaces.
const PRESET_COLORS = [
	"#ef4444", // red
	"#f97316", // orange
	"#f59e0b", // amber
	"#eab308", // yellow
	"#84cc16", // lime
	"#22c55e", // green
	"#10b981", // emerald
	"#06b6d4", // cyan
	"#3b82f6", // blue
	"#8b5cf6", // violet
	"#ec4899", // pink
];

// biome-ignore lint/style/noNonNullAssertion: guaranteed by array size
const DEFAULT_COLOR = PRESET_COLORS[9]!; // violet

let {
	open = $bindable(false),
	mode = "create",
	tag = null,
	onCreated,
	onUpdated,
	onClose,
}: {
	open?: boolean;
	mode?: "create" | "edit";
	tag?: Tag | null;
	onCreated?: (tag: Tag) => void;
	onUpdated?: (tag: Tag) => void;
	onClose?: () => void;
} = $props();

let name = $state("");
let color = $state(DEFAULT_COLOR);
let nameError = $state<string | null>(null);
let submitError = $state<string | null>(null);
let submitting = $state(false);

const isEdit = $derived(mode === "edit");
const dialogTitle = $derived(isEdit ? m.tags_edit() : m.tags_new());
const submitLabel = $derived(
	submitting
		? m.action_loading()
		: isEdit
			? m.action_save()
			: m.action_create(),
);

function reset() {
	name = "";
	color = DEFAULT_COLOR;
	nameError = null;
	submitError = null;
	submitting = false;
}

function seedFromTag(t: Tag | null) {
	if (!t) {
		reset();
		return;
	}
	name = t.name;
	color = t.color ?? DEFAULT_COLOR;
	nameError = null;
	submitError = null;
	submitting = false;
}

function close() {
	open = false;
	reset();
	onClose?.();
}

function handleOpenChange(next: boolean) {
	if (next) {
		seedFromTag(tag);
	} else {
		reset();
		open = false;
		onClose?.();
	}
}

function handleSubmit(e: Event) {
	e.preventDefault();
	nameError = null;
	submitError = null;

	const trimmed = name.trim();
	if (trimmed.length === 0) {
		nameError = m.tags_name_placeholder();
		return;
	}

	if (isEdit && tag) {
		const parsed = updateTagInputSchema.safeParse({
			name: trimmed,
			color,
		});
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			nameError = issue?.message ?? m.error_generic();
			return;
		}
		void doUpdate(tag.id, parsed.data);
	} else {
		const parsed = createTagInputSchema.safeParse({
			name: trimmed,
			color,
		});
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			nameError = issue?.message ?? m.error_generic();
			return;
		}
		void doCreate(parsed.data.name, color);
	}
}

async function doCreate(trimmed: string, pickedColor: string) {
	submitting = true;
	try {
		const created = await createTag(trimmed, pickedColor);
		onCreated?.(created);
		close();
	} catch (e) {
		submitError = e instanceof Error ? e.message : m.error_generic();
		console.error("TagCreateDialog: createTag failed", e);
	} finally {
		submitting = false;
	}
}

async function doUpdate(id: string, data: { name?: string; color?: string }) {
	submitting = true;
	try {
		const updated = await updateTag(id, data);
		onUpdated?.(updated);
		close();
	} catch (e) {
		submitError = e instanceof Error ? e.message : m.error_generic();
		console.error("TagCreateDialog: updateTag failed", e);
	} finally {
		submitting = false;
	}
}

function handleInputKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !submitting) {
		e.preventDefault();
		handleSubmit(new Event("submit"));
	}
}

$effect(() => {
	if (open && mode === "edit" && tag) {
		name = tag.name;
		color = tag.color ?? DEFAULT_COLOR;
		nameError = null;
		submitError = null;
	}
});
</script>

<Dialog bind:open onOpenChange={handleOpenChange}>
  <DialogHeader>
    <DialogTitle>{dialogTitle}</DialogTitle>
    <DialogDescription>{m.tags_name_placeholder()}</DialogDescription>
  </DialogHeader>

  <form onsubmit={handleSubmit} class="space-y-4">
    <div class="space-y-2">
      <Label for="tag-name" class="sr-only">{m.tags_name_placeholder()}</Label>
      <Input
        id="tag-name"
        name="name"
        type="text"
        bind:value={name}
        placeholder={m.tags_name_placeholder()}
        maxlength={50}
        required
        disabled={submitting}
        aria-invalid={nameError ? "true" : undefined}
        aria-describedby={nameError ? "tag-name-error" : undefined}
        autocomplete="off"
        onkeydown={handleInputKeydown}
      />
      {#if nameError}
        <p id="tag-name-error" class="text-xs text-destructive">{nameError}</p>
      {/if}
    </div>

    <div class="space-y-2">
      <Label for="tag-color" class="text-xs text-muted-foreground">
        Color
      </Label>
      <div id="tag-color" class="flex flex-wrap gap-2">
        {#each PRESET_COLORS as preset (preset)}
          {@const selected = color === preset}
          <button
            type="button"
            class={cn(
              "size-6 shrink-0 rounded-full border-2 transition-all",
              selected
                ? "scale-110 border-foreground"
                : "border-transparent hover:scale-105",
            )}
            style="background-color: {preset};"
            aria-label="Color {preset}"
            aria-pressed={selected}
            disabled={submitting}
            onclick={() => (color = preset)}
          ></button>
        {/each}
        <label
          class={cn(
            "relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 transition-all",
            !PRESET_COLORS.includes(color)
              ? "scale-110 border-foreground"
              : "border-transparent hover:scale-105",
          )}
          style="background-color: {color};"
          title="Custom color"
        >
          <input
            type="color"
            value={color}
            disabled={submitting}
            oninput={(e) =>
              (color = (e.currentTarget as HTMLInputElement).value)}
            class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Custom color"
          />
        </label>
      </div>
    </div>

    {#if submitError}
      <p class="text-xs text-destructive" role="alert">{submitError}</p>
    {/if}
  </form>

  <DialogFooter>
    <Button variant="outline" type="button" onclick={close} disabled={submitting}>
      {m.action_cancel()}
    </Button>
    <Button
      type="submit"
      onclick={handleSubmit}
      disabled={submitting || name.trim().length === 0}
    >
      {#if submitting}
        <Loader2 class="mr-1 size-4 animate-spin" />
      {/if}
      {submitLabel}
    </Button>
  </DialogFooter>
</Dialog>
