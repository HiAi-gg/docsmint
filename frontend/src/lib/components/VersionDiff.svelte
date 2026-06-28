<!-- VersionDiff.svelte — Side-by-side or inline diff between two versions.

     Loads version metadata + content via
       GET /api/documents/:id/versions
     then asks the server for the actual diff hunks via
       GET /api/documents/:id/versions/:vid1/diff/:vid2

     The same `hunks` payload drives both views:
       * Inline — render each hunk in order with +/-/· gutter markers
         and the spec'd colors (#dcfce7 / #fee2e2 / gray).
       * Side by side — pair consecutive remove + add hunks into a single
         table row so each removed line sits beside its added replacement
         (or stands alone when one side has no match). -->
<script lang="ts">
import { ArrowLeftRight, Loader2 } from "lucide-svelte";
import { ApiError, apiFetch } from "$lib/api/client";
import * as m from "$lib/paraglide/messages.js";

// Background colors specified by the API consumer (light theme).
const ADDED_BG = "#dcfce7";
const REMOVED_BG = "#fee2e2";
const ADDED_TEXT_DARK = "#15803d";
const REMOVED_TEXT_DARK = "#b91c1c";

type HunkType = "add" | "remove" | "unchanged";
interface DiffHunk {
	type: HunkType;
	lines: string[];
}
interface DiffChanges {
	added: number;
	removed: number;
	modified: number;
}
interface DiffVersionMeta {
	id: string;
	label: string | null;
	createdAt: string;
}
interface DiffResponse {
	v1: DiffVersionMeta;
	v2: DiffVersionMeta;
	changes: DiffChanges;
	hunks: DiffHunk[];
}
interface VersionListItem {
	id: string;
	label?: string | null;
	createdAt: string;
	isSnapshot?: boolean;
}

type DiffMode = "inline" | "split";

const { documentId }: { documentId: string } = $props();

let versionList = $state<VersionListItem[]>([]);
let loadingList = $state(true);
let listError = $state<string | null>(null);

let oldVersionId = $state<string>("");
let newVersionId = $state<string>("");

let diff = $state<DiffResponse | null>(null);
let diffLoading = $state(false);
let diffError = $state<string | null>(null);
let diffMode = $state<DiffMode>("inline");

// Stable function to load the version list. Re-fetched when the parent
// swaps `documentId`.
async function loadVersions() {
	loadingList = true;
	listError = null;
	try {
		const all = await apiFetch<VersionListItem[]>(
			`/api/documents/${documentId}/versions`,
		);
		versionList = all;
		// Pick sensible defaults: newest two versions in chronological
		// order (oldest on the left, newest on the right). The server
		// already returns them newest-first.
		if (all.length >= 2) {
			newVersionId = all[0]?.id ?? "";
			oldVersionId = all[1]?.id ?? "";
		} else if (all.length === 1) {
			oldVersionId = all[0]?.id ?? "";
			newVersionId = all[0]?.id ?? "";
		} else {
			oldVersionId = "";
			newVersionId = "";
		}
	} catch (e) {
		listError = e instanceof Error ? e.message : String(e);
		console.error("VersionDiff: list failed", e);
	} finally {
		loadingList = false;
	}
}

$effect(() => {
	void documentId;
	void loadVersions();
});

// Compute the diff whenever both endpoints are set (and the user has
// made a selection). We use the form's URL params style to encode
// which is "before" and which is "after" — the server treats vid1 as
// the older side and vid2 as the newer side.
$effect(() => {
	if (!oldVersionId || !newVersionId) {
		diff = null;
		return;
	}
	if (oldVersionId === newVersionId) {
		// Identical selection: synthesize an empty diff so the UI shows
		// the "no differences" hint without making a useless request.
		const v = versionList.find((x) => x.id === oldVersionId);
		diff = {
			v1: {
				id: oldVersionId,
				label: v?.label ?? null,
				createdAt: v?.createdAt ?? new Date().toISOString(),
			},
			v2: {
				id: newVersionId,
				label: v?.label ?? null,
				createdAt: v?.createdAt ?? new Date().toISOString(),
			},
			changes: { added: 0, removed: 0, modified: 0 },
			hunks: [],
		};
		diffError = null;
		return;
	}
	void fetchDiff(oldVersionId, newVersionId);
});

async function fetchDiff(v1Id: string, v2Id: string) {
	diffLoading = true;
	diffError = null;
	try {
		const response = await apiFetch<DiffResponse>(
			`/api/documents/${documentId}/versions/diff?from=${v1Id}&to=${v2Id}`,
		);
		diff = response;
	} catch (e) {
		if (e instanceof ApiError) {
			diffError = `${m.error_generic()}: ${e.message}`;
		} else {
			diffError = e instanceof Error ? e.message : m.error_generic();
		}
		console.error("VersionDiff: diff fetch failed", e);
	} finally {
		diffLoading = false;
	}
}

function formatTimestamp(value: string): string {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return value;
	return d.toLocaleString();
}

function swap() {
	const tmp = oldVersionId;
	oldVersionId = newVersionId;
	newVersionId = tmp;
}

// --- Inline rendering helpers ---

function hunkGutterMarker(type: HunkType): string {
	if (type === "add") return "+";
	if (type === "remove") return "-";
	return " ";
}

function hunkRowStyle(type: HunkType): string {
	if (type === "add") {
		return `background-color: ${ADDED_BG}; color: ${ADDED_TEXT_DARK};`;
	}
	if (type === "remove") {
		return `background-color: ${REMOVED_BG}; color: ${REMOVED_TEXT_DARK};`;
	}
	return "";
}

// --- Side-by-side pairing ---

/**
 * Pair remove + add hunks into row-aligned pairs. Walks the hunk list
 * and produces a stream of `SplitRow` rows where each row has an `old`
 * and `new` side. Pairing rule: walk hunks linearly, looking ahead —
 * when a remove is followed by an add, fold them into N rows where N
 * is max(remove.lines, add.lines); each row's "old" gets the next
 * remove line (or empty when the remove is exhausted) and "new" gets
 * the next add line (or empty). Consecutive same-side hunks (e.g. two
 * removes in a row) stay separate rows with the matching side blank.
 */
interface SplitRow {
	oldKind: HunkType;
	oldText: string;
	newKind: HunkType;
	newText: string;
}

function pairForSplit(hunks: DiffHunk[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;
	while (i < hunks.length) {
		const h = hunks[i];
		if (!h) {
			i++;
			continue;
		}
		if (h.type === "unchanged") {
			for (const line of h.lines) {
				rows.push({
					oldKind: "unchanged",
					oldText: line,
					newKind: "unchanged",
					newText: line,
				});
			}
			i++;
			continue;
		}
		// Single-sided runs (no following opposite hunk) just expand
		// into rows where the empty side is blank.
		if (h.type === "remove" && hunks[i + 1]?.type !== "add") {
			for (const line of h.lines) {
				rows.push({
					oldKind: "remove",
					oldText: line,
					newKind: "unchanged",
					newText: "",
				});
			}
			i++;
			continue;
		}
		if (h.type === "add" && hunks[i - 1]?.type !== "remove") {
			for (const line of h.lines) {
				rows.push({
					oldKind: "unchanged",
					oldText: "",
					newKind: "add",
					newText: line,
				});
			}
			i++;
			continue;
		}
		// remove followed by add → pair them up row by row.
		if (h.type === "remove") {
			const next = hunks[i + 1];
			if (next?.type === "add") {
				const removes = h.lines;
				const adds = next.lines;
				const len = Math.max(removes.length, adds.length);
				for (let k = 0; k < len; k++) {
					rows.push({
						oldKind: "remove",
						oldText: removes[k] ?? "",
						newKind: "add",
						newText: adds[k] ?? "",
					});
				}
				i += 2;
				continue;
			}
		}
		// Fallback (shouldn't normally hit): render the raw hunk on its
		// matching side.
		const kind = h.type;
		for (const line of h.lines) {
			rows.push({
				oldKind: kind === "add" ? "unchanged" : kind,
				oldText: kind === "add" ? "" : line,
				newKind: kind === "remove" ? "unchanged" : kind,
				newText: kind === "remove" ? "" : line,
			});
		}
		i++;
	}
	return rows;
}
</script>

<div class="flex flex-col gap-3 p-4">
	<div class="flex items-center gap-2 text-sm font-medium text-foreground">
		<ArrowLeftRight class="h-4 w-4" />
		<span>Version diff</span>
	</div>

	<!-- Version pickers + swap button + mode toggle -->
	<div class="flex flex-wrap items-end gap-2">
		<div class="flex flex-1 flex-col gap-1">
			<label
				for="version-diff-old"
				class="text-xs font-medium text-muted-foreground"
			>
				{m.version_diff_pick_old()}
			</label>
			<select
				id="version-diff-old"
				bind:value={oldVersionId}
				disabled={loadingList || versionList.length === 0}
				class="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if versionList.length === 0}
					<option value="">—</option>
				{/if}
				{#each versionList as v (v.id)}
					<option value={v.id}>
						{v.label ?? v.id.slice(0, 8)} · {formatTimestamp(v.createdAt)}
					</option>
				{/each}
			</select>
		</div>

		<button
			type="button"
			class="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-2 text-xs hover:bg-accent disabled:opacity-50"
			onclick={swap}
			disabled={!oldVersionId || !newVersionId}
			title="Swap"
			aria-label="Swap old and new"
		>
			⇄
		</button>

		<div class="flex flex-1 flex-col gap-1">
			<label
				for="version-diff-new"
				class="text-xs font-medium text-muted-foreground"
			>
				{m.version_diff_pick_new()}
			</label>
			<select
				id="version-diff-new"
				bind:value={newVersionId}
				disabled={loadingList || versionList.length === 0}
				class="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if versionList.length === 0}
					<option value="">—</option>
				{/if}
				{#each versionList as v (v.id)}
					<option value={v.id}>
						{v.label ?? v.id.slice(0, 8)} · {formatTimestamp(v.createdAt)}
					</option>
				{/each}
			</select>
		</div>

		<!-- Mode toggle -->
		<div
			class="inline-flex overflow-hidden rounded-md border border-border text-xs"
			role="tablist"
			aria-label="Diff mode"
		>
			<button
				type="button"
				role="tab"
				aria-selected={diffMode === "inline"}
				class="px-2 py-1 transition-colors {diffMode === 'inline'
					? 'bg-primary text-primary-foreground'
					: 'bg-background text-muted-foreground hover:bg-accent'}"
				onclick={() => (diffMode = "inline")}
			>
				{m.version_diff_mode_inline()}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={diffMode === "split"}
				class="px-2 py-1 transition-colors {diffMode === 'split'
					? 'bg-primary text-primary-foreground'
					: 'bg-background text-muted-foreground hover:bg-accent'}"
				onclick={() => (diffMode = "split")}
			>
				{m.version_diff_mode_side_by_side()}
			</button>
		</div>
	</div>

	{#if listError}
		<p class="text-xs text-destructive" role="alert">{listError}</p>
	{/if}

	{#if diff}
		<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
			<div class="flex flex-wrap items-center gap-2">
				<span class="inline-flex items-center gap-1">
					<span class="font-mono">v1:</span>
					<span>{diff.v1.label ?? diff.v1.id.slice(0, 8)}</span>
					<span class="text-[10px]">· {formatTimestamp(diff.v1.createdAt)}</span>
				</span>
				<span>→</span>
				<span class="inline-flex items-center gap-1">
					<span class="font-mono">v2:</span>
					<span>{diff.v2.label ?? diff.v2.id.slice(0, 8)}</span>
					<span class="text-[10px]">· {formatTimestamp(diff.v2.createdAt)}</span>
				</span>
			</div>
			<span>
				{m.version_diff_stats({
					added: diff.changes.added,
					removed: diff.changes.removed,
					modified: diff.changes.modified,
				})}
			</span>
		</div>

		{#if diffLoading}
			<div
				class="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
			>
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
				<span>{m.version_diff_loading()}</span>
			</div>
		{:else if diffError}
			<p class="text-xs text-destructive" role="alert">{diffError}</p>
		{:else if diff.hunks.length === 0}
			<p class="py-4 text-center text-xs text-muted-foreground">
				{m.version_diff_empty()}
			</p>
		{:else if diffMode === "inline"}
			<div class="overflow-auto rounded-md border border-border font-mono text-sm">
				{#each diff.hunks as hunk, hunkIndex (hunkIndex)}
					{#each hunk.lines as line, lineIndex (hunkIndex + "-" + lineIndex)}
						<div
							class="flex px-3 py-0.5"
							style={hunkRowStyle(hunk.type)}
						>
							<span
								class="mr-3 inline-block w-4 shrink-0 text-right text-muted-foreground select-none"
							>
								{hunkGutterMarker(hunk.type)}
							</span>
							<span class="whitespace-pre-wrap break-words">{line}</span>
						</div>
					{/each}
				{/each}
			</div>
		{:else}
			{@const splitRows = pairForSplit(diff.hunks)}
			<div class="overflow-auto rounded-md border border-border font-mono text-sm">
				<div class="grid grid-cols-2">
					{#each splitRows as row, i (i)}
						<!-- Left (old) cell -->
						<div
							class="flex border-r border-border px-3 py-0.5"
							style={hunkRowStyle(row.oldKind)}
						>
							<span
								class="mr-3 inline-block w-4 shrink-0 text-right text-muted-foreground select-none"
							>
								{hunkGutterMarker(row.oldKind)}
							</span>
							<span class="whitespace-pre-wrap break-words">{row.oldText}</span>
						</div>
						<!-- Right (new) cell -->
						<div
							class="flex px-3 py-0.5"
							style={hunkRowStyle(row.newKind)}
						>
							<span
								class="mr-3 inline-block w-4 shrink-0 text-right text-muted-foreground select-none"
							>
								{hunkGutterMarker(row.newKind)}
							</span>
							<span class="whitespace-pre-wrap break-words">{row.newText}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{:else if loadingList || diffLoading}
		<div
			class="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
		>
			<Loader2 class="h-3.5 w-3.5 animate-spin" />
			<span>{m.version_diff_loading()}</span>
		</div>
	{/if}
</div>
