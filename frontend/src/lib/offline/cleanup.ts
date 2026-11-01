import { deleteOfflineDB, getOfflineDB } from "#lib/db/index.js";
import {
	disableOfflineAccess,
	resolveOfflineIdentity,
} from "#lib/offline/identity.js";

/**
 * Wipe all offline data for the current identity. Called on logout so a
 * shared browser never leaks one user's cached documents, drafts, or queued
 * mutations to the next user.
 *
 * Best-effort: failures are logged but never thrown, so logout always
 * completes.
 */
export async function cleanupOfflineData(): Promise<void> {
	let identity: Awaited<ReturnType<typeof resolveOfflineIdentity>> | null =
		null;
	try {
		identity = await resolveOfflineIdentity();
	} catch {
		// A missing/network-failed session must not preserve a stale device
		// binding. Cache cleanup below is app-scoped and does not need an owner.
	} finally {
		// Fail closed before touching IndexedDB or Cache Storage. Any later
		// cleanup failure must not make the previous owner selectable again.
		disableOfflineAccess();
	}

	const appId = import.meta.env.VITE_APP_ID ?? "hiai-docs";
	const deploymentId =
		import.meta.env.VITE_DEPLOYMENT_ID ?? "hiai-docs-pwa-local";
	const cachePrefix = `${appId}::${deploymentId}::pwa-v1`;

	try {
		if (identity) {
			try {
				const db = getOfflineDB(identity);
				// Best-effort table clearing handles databases that are already open;
				// exact database deletion below remains the authoritative cleanup.
				await Promise.allSettled([
					db.documents.clear(),
					db.folders.clear(),
					db.drafts.clear(),
					db.mutationQueue?.clear(), // legacy rows are discarded, never replayed
					db.metadata.clear(),
				]);
			} finally {
				await deleteOfflineDB(identity).catch(() => undefined);
			}
		}

		// Clear the Workbox/runtime caches that belong to this app.
		const cacheNames = await caches.keys();
		await Promise.all(
			cacheNames
				.filter(
					(name) =>
						name.startsWith(`${cachePrefix}::`) ||
						name.startsWith(`${cachePrefix}-`),
				)
				.map((name) => caches.delete(name)),
		);

		// Ask the active service worker to drop its own caches too. Do not await
		// `serviceWorker.ready`: it remains pending forever when registration is
		// unavailable and used to block logout/disable-offline actions.
		if ("serviceWorker" in navigator) {
			const registration = await navigator.serviceWorker.getRegistration("/");
			registration?.active?.postMessage({
				type: "CLEAR_HOST_CACHES",
				cachePrefix,
			});
		}
	} catch {
		// Cleanup is fail-closed and best-effort; callers must still complete
		// logout even when IndexedDB or Cache Storage is unavailable.
	}
}
