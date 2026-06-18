// tag-store.svelte.ts — Module-level reactive signal for cross-component
// tag list refresh. The sidebar TagList loads tags only on mount, so any
// tag mutation elsewhere (e.g. the document editor) needs to nudge it to
// reload. We expose a simple monotonically-increasing nonce that callers
// can read inside a $effect to trigger refreshes.

let tagRefreshNonce = $state(0);

export function refreshTags(): void {
	tagRefreshNonce++;
}

export function getTagRefreshNonce(): number {
	return tagRefreshNonce;
}

// Module-level reactive signal for cross-component document list refresh.
// The sidebar components (RecentDocs, FolderTree) and any other doc
// consumer load documents only on mount, so any document mutation
// elsewhere (e.g. the dashboard Import button) needs to nudge them to
// reload. Same nonce pattern as tagRefreshNonce: callers read it inside
// a $effect to trigger refreshes.
let docRefreshNonce = $state(0);

export function refreshDocs(): void {
	docRefreshNonce++;
}

export function getDocRefreshNonce(): number {
	return docRefreshNonce;
}

// Module-level reactive signal for the currently selected tag filter. Set by
// the sidebar TagList; read by the dashboard and the sidebar RecentDocs so a
// tag selection filters every document list in one place. `null` means no
// filter (show all).
let selectedTagId = $state<string | null>(null);
// Tag NAME for the same selection. List endpoints filter by tag id, but the
// search endpoint filters by tag name, so we keep both in sync here.
let selectedTagName = $state<string | null>(null);

export function setSelectedTag(
	id: string | null,
	name: string | null = null,
): void {
	selectedTagId = id;
	selectedTagName = id ? name : null;
}

export function getSelectedTag(): string | null {
	return selectedTagId;
}

export function getSelectedTagName(): string | null {
	return selectedTagName;
}
