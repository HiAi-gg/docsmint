<!-- VersionHistory.svelte — Sidebar list of document versions.

     Responsibilities:
       * Load versions via GET /api/documents/:id/versions
       * Toggle "All" vs "Snapshots only" (filters the same list locally,
         since the server returns both kinds in one call)
       * Trigger a restore flow: confirmation dialog → POST .../restore
         → reload the document content via the `onRestored` callback prop
         (and a custom `version-restored` DOM event as a fallback hook
         for parents that prefer event-style wiring).
       * Surface snapshot metadata (label badge, "Restored from v..." line)
         and an at-a-glance preview of the version content.
       * Expose a CreateSnapshotDialog for ad-hoc snapshots. -->
<script lang="ts">
import {
	Camera,
	CheckCircle2,
	Clock,
	History,
	Loader2,
	RotateCcw,
	Star,
} from "lucide-svelte";
import { ApiError, apiFetch } from "$lib/api/client";
import CreateSnapshotDialog from "$lib/components/CreateSnapshotDialog.svelte";
import ConfirmDialog from "$lib/components/ui/confirm-dialog/ConfirmDialog.svelte";
import * as m from "$lib/paraglide/messages.js";

interface Version {
	id: string;
	documentId: string;
	content: string;
	contentJson?: unknown;
	createdBy: string;
	createdAt: string;
	label?: string | null;
	description?: string | null;
	isSnapshot?: boolean;
	restoredFrom?: string | null;
}

type FilterMode = "all" | "snapshots";

const {
	documentId,
	onRestored,
}: {
	documentId: string;
	/** Called after a successful restore so the parent can re-fetch the
	 *  document body and re-render the editor. Optional. */
	onRestored?: (restoredVersion: Version) => void;
} = $props();

let versions = $state<Version[]>([]);
let loading = $state(true);
let loadError = $state<string | null>(null);
let filter = $state<FilterMode>("all");

// Create-snapshot dialog state (parent owns `open` via bind; local state
// tracks success lifecycle so the panel can refresh immediately).
let snapshotDialogOpen = $state(false);

// Restore confirmation dialog state. We keep `restoreDialogOpen` as a
// plain $bindable boolean (so the ConfirmDialog two-way binding stays
// simple) and a separate `pendingRestore` that holds the version the
// user is about to restore. `confirmRestore()` reads from
// `pendingRestore` so we know which version to POST against.
let restoreDialogOpen = $state(false);
let pendingRestore = $state<Version | null>(null);
let restoring = $state(false);
let restoreError = $state<string | null>(null);

async function loadVersions() {
	loading = true;
	loadError = null;
	try {
		versions = await apiFetch<Version[]>(
			`/api/documents/${documentId}/versions`,
		);
	} catch (e) {
		loadError = e instanceof Error ? e.message : String(e);
		console.error("Failed to load versions", e);
	} finally {
		loading = false;
	}
}

// Initial load + reload whenever the parent swaps `documentId`.
$effect(() => {
	void documentId;
	void loadVersions();
});

// When the ConfirmDialog closes via Escape/backdrop (Cancel button calls
// onCancel which already runs cancelRestore), clear the pending version
// so we don't restore stale state.
$effect(() => {
	if (restoreDialogOpen) return;
	if (restoring) return;
	if (pendingRestore !== null) {
		pendingRestore = null;
	}
});

const visibleVersions = $derived.by<Version[]>(() => {
	if (filter === "snapshots") {
		return versions.filter((v) => v.isSnapshot === true);
	}
	return versions;
});

const snapshotCount = $derived(
	versions.reduce((n, v) => (v.isSnapshot ? n + 1 : n), 0),
);

const restoreDialogDescription = $derived(
	pendingRestore?.label
		? `${m.version_restore_confirm()} (${pendingRestore.label})`
		: m.version_restore_confirm(),
);

/** Trim content to a single-line preview (strip markdown + truncate). */
function previewFromContent(content: string | undefined): string {
	if (!content) return "";
	const stripped = content
		.replace(/```[\s\S]*?```/g, "")
		.replace(/[#*_`>~-]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return stripped.length > 100 ? `${stripped.slice(0, 100)}…` : stripped;
}

function relativeTime(value: string | Date): string {
	const created = typeof value === "string" ? new Date(value) : value;
	const diff = Date.now() - created.getTime();
	if (Number.isNaN(diff)) return "";
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return m.time_minutes_ago({ count: 0 });
	if (mins < 60) return m.time_minutes_ago({ count: mins });
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return m.time_hours_ago({ count: hrs });
	return m.time_days_ago({ count: Math.floor(hrs / 24) });
}

function promptRestore(version: Version) {
	pendingRestore = version;
	restoreError = null;
	restoreDialogOpen = true;
}

function cancelRestore() {
	if (restoring) return;
	pendingRestore = null;
	restoreError = null;
}

async function confirmRestore() {
	const target = pendingRestore;
	if (!target || restoring) return;
	restoring = true;
	restoreError = null;
	try {
		await apiFetch<{ documentId: string; restoredFrom: string }>(
			`/api/documents/${documentId}/versions/${target.id}/restore`,
			{ method: "POST" },
		);
		// Re-fetch the list so the new "current" version + restoredFrom
		// bookkeeping appear, then notify the parent.
		await loadVersions();
		pendingRestore = null;
		restoreDialogOpen = false;
		onRestored?.(target);
		// Fire a DOM CustomEvent as a fallback hook for parents that
		// prefer event-style wiring (mirrors `onRestored`).
		if (typeof window !== "undefined") {
			window.dispatchEvent(
				new CustomEvent("version-restored", {
					detail: {
						documentId,
						versionId: target.id,
					},
				}),
			);
		}
	} catch (e) {
		if (e instanceof ApiError) {
			restoreError = `${m.version_restore_failed()}: ${e.message}`;
		} else {
			restoreError = e instanceof Error ? e.message : m.error_generic();
		}
		console.error("Failed to restore version", e);
	} finally {
		restoring = false;
	}
}

function handleSnapshotCreated() {
	// Refresh the version list so the newly-created snapshot appears at
	// the top (server orders by createdAt desc).
	void loadVersions();
}

function findVersionLabel(id: string | null | undefined): string | null {
	if (!id) return null;
	const v = versions.find((vv) => vv.id === id);
	if (!v) return id.slice(0, 8);
	return v.label ?? id.slice(0, 8);
}
</script>

<div class="flex flex-col gap-2 p-4">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 text-sm font-medium text-foreground">
			<History class="h-4 w-4" />
			<span>{m.version_history_title()}</span>
		</div>
		<button
			type="button"
			class="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
			onclick={() => (snapshotDialogOpen = true)}
			disabled={loading}
			title={m.version_create_snapshot()}
			aria-label={m.version_create_snapshot()}
		>
			<Camera class="h-3 w-3" />
			{m.version_create_snapshot()}
		</button>
	</div>

	{#if versions.length > 0}
		<!-- Filter toggle: All vs Snapshots only -->
		<div
			class="inline-flex w-full overflow-hidden rounded-md border border-border text-xs"
			role="tablist"
			aria-label={m.version_filter_all()}
		>
			<button
				type="button"
				role="tab"
				aria-selected={filter === "all"}
				class="flex-1 px-2 py-1 transition-colors {filter === 'all'
					? 'bg-primary text-primary-foreground'
					: 'bg-background text-muted-foreground hover:bg-accent'}"
				onclick={() => (filter = "all")}
			>
				{m.version_filter_all()} ({versions.length})
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={filter === "snapshots"}
				class="flex-1 px-2 py-1 transition-colors {filter === 'snapshots'
					? 'bg-primary text-primary-foreground'
					: 'bg-background text-muted-foreground hover:bg-accent'}"
				onclick={() => (filter = "snapshots")}
			>
				{m.version_filter_snapshots()} ({snapshotCount})
			</button>
		</div>
	{/if}

	{#if loading}
		<div
			class="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"
		>
			<Loader2 class="h-3.5 w-3.5 animate-spin" />
			<span>{m.action_loading()}</span>
		</div>
	{:else if loadError}
		<p class="py-4 text-center text-xs text-destructive">{loadError}</p>
	{:else if visibleVersions.length === 0}
		<p class="py-4 text-center text-xs text-muted-foreground">
			{m.version_history_empty()}
		</p>
	{:else}
		<div class="flex flex-col gap-1 overflow-y-auto max-h-80">
			{#each visibleVersions as version (version.id)}
				<div
					class="flex items-start gap-3 rounded-md border border-border p-3 text-sm hover:bg-accent transition-colors"
				>
					{#if version.isSnapshot}
						<Star
							class="mt-0.5 h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500"
							aria-label={m.version_badge_snapshot()}
						/>
					{:else}
						<Clock class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					{/if}
					<div class="flex-1 min-w-0">
						<div class="flex items-center justify-between gap-2">
							<div class="flex flex-col gap-0.5 min-w-0">
								{#if version.label}
									<span
										class="truncate text-xs font-medium text-foreground"
										title={version.label}
									>
										{version.label}
									</span>
								{/if}
								<span class="text-xs text-muted-foreground">
									{relativeTime(version.createdAt)}
								</span>
							</div>
							<button
								type="button"
								class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
								title={m.version_restore()}
								aria-label={m.version_restore()}
								onclick={() => promptRestore(version)}
							>
								<RotateCcw class="h-3 w-3" />
								{m.version_restore_short()}
							</button>
						</div>
						{#if version.isSnapshot}
							<div class="mt-1 flex flex-wrap items-center gap-1">
								<span
									class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
								>
									<Star class="h-2.5 w-2.5" />
									{m.version_badge_snapshot()}
								</span>
								{#if version.description}
									<span
										class="truncate text-[11px] text-muted-foreground"
										title={version.description}
									>
										{version.description}
									</span>
								{/if}
							</div>
						{/if}
						{#if version.restoredFrom}
							<div
								class="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
							>
								<CheckCircle2 class="h-3 w-3" />
								{m.version_restored_from()}
								<code class="rounded bg-muted px-1 font-mono text-[10px]">
									{findVersionLabel(version.restoredFrom) ?? "—"}
								</code>
							</div>
						{/if}
						<p
							class="mt-1 truncate text-xs text-muted-foreground"
							title={previewFromContent(version.content)}
						>
							{previewFromContent(version.content)}
						</p>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<ConfirmDialog
	bind:open={restoreDialogOpen}
	title={m.version_restore()}
	description={restoreDialogDescription}
	confirmLabel={m.version_restore_short()}
	cancelLabel={m.action_cancel()}
	variant="default"
	busy={restoring}
	onConfirm={confirmRestore}
	onCancel={cancelRestore}
/>

{#if restoreError}
	<p class="sr-only" role="alert">{restoreError}</p>
{/if}

<CreateSnapshotDialog
	bind:open={snapshotDialogOpen}
	{documentId}
	onSuccess={handleSnapshotCreated}
/>
