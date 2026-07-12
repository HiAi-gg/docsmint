// subfolders-refresh-store.svelte.ts — Module-level reactive signal for
// per-folder subfolder-list refreshes.
//
// FolderNode subfolder lists are lazy: a `FolderNode` only fetches its
// children via `getFolder(id)` the first time the user expands it. That
// means a successful nested-folder DnD persist (which mutates `parentId`
// on the server) leaves the affected FolderNode instances showing stale
// data — the moved folder only appears in its new parent's list after
// the user collapses and re-expands, or reloads the page.
//
// To work around this, FolderTree bumps a per-folder refresh nonce after
// every nested-folder DnD persist. Each FolderNode reads the nonce for
// its own id inside a `$effect` and refetches its subfolders when it
// increments.
//
// Using a module-level reactive Map (instead of props) lets the
// recursive FolderNode instances also see their own id's nonce without
// threading it down through every recursion level.

export interface FolderRegistryEntry {
	parentId: string | null;
	categoryId: string | null;
	order: number;
}

export interface DocumentRegistryEntry {
	folderId: string | null;
	categoryId: string | null;
}

const refreshNonces = $state<Record<string, number>>({});
const foldersRegistry = $state<Record<string, FolderRegistryEntry>>({});
const documentsRegistry = $state<Record<string, DocumentRegistryEntry>>({});

let documentPlacementNonce = $state(0);
let latestDocumentPlacement = $state<
	({ id: string; version: number } & DocumentRegistryEntry) | null
>(null);
const pendingDocumentPlacements = $state<
	Record<string, { version: number } & DocumentRegistryEntry>
>({});

let globalFolderRefreshNonce = $state(0);

export function refreshFolders(): void {
	globalFolderRefreshNonce++;
}

export function getGlobalFolderRefreshNonce(): number {
	return globalFolderRefreshNonce;
}

export function bumpSubfoldersRefresh(folderId: string): void {
	refreshNonces[folderId] = (refreshNonces[folderId] ?? 0) + 1;
}

export function getSubfoldersRefresh(folderId: string): number {
	return refreshNonces[folderId] ?? 0;
}

export function registerFolder(
	id: string,
	parentId: string | null,
	categoryId: string | null,
	order: number,
): void {
	foldersRegistry[id] = { parentId, categoryId, order };
}

export function getFolderFromRegistry(
	id: string,
): FolderRegistryEntry | undefined {
	return foldersRegistry[id];
}

export function registerDocument(
	id: string,
	folderId: string | null,
	categoryId: string | null,
): void {
	documentsRegistry[id] = { folderId, categoryId };
}

/**
 * Publishes an optimistic document move to every mounted navigation surface.
 * The nonce makes repeated moves of the same document observable to Svelte.
 */
export function publishDocumentPlacement(
	id: string,
	folderId: string | null,
	categoryId: string | null,
): number {
	registerDocument(id, folderId, categoryId);
	const version = ++documentPlacementNonce;
	latestDocumentPlacement = { id, folderId, categoryId, version };
	pendingDocumentPlacements[id] = { folderId, categoryId, version };
	return version;
}

export function acknowledgeDocumentPlacement(
	id: string,
	version: number,
): void {
	if (pendingDocumentPlacements[id]?.version === version) {
		delete pendingDocumentPlacements[id];
	}
}

export function supersedePendingDocumentPlacement(id: string): void {
	delete pendingDocumentPlacements[id];
}

export function getPendingDocumentPlacement(
	id: string,
): ({ version: number } & DocumentRegistryEntry) | undefined {
	return pendingDocumentPlacements[id];
}

export function getDocumentPlacementNonce(): number {
	return documentPlacementNonce;
}

export function getLatestDocumentPlacement():
	| ({ id: string; version: number } & DocumentRegistryEntry)
	| null {
	return latestDocumentPlacement;
}

export function getDocumentFromRegistry(
	id: string,
): DocumentRegistryEntry | undefined {
	return documentsRegistry[id];
}
