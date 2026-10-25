import { getSession } from "#lib/auth-client.js";

/**
 * Identity that scopes the offline database. The DB name is derived from
 * these fields so that each (app, deployment, owner, tenant) combination
 * gets an isolated IndexedDB instance. This prevents cross-user and
 * cross-tenant data leakage when the same browser is shared.
 */
export interface OfflineIdentity {
	/** Application id, e.g. "hiai-docs". */
	appId: string;
	/** Build/deploy hash or version. */
	deploymentId: string;
	/** Better Auth user id. */
	ownerId: string;
	/** Reserved multi-tenant column; undefined for single-tenant. */
	tenantId?: string;
}

const OWNER_ID_CACHE_KEY = "hiai-docs:offline-owner-id";
const OFFLINE_BINDING_KEY = "hiai-docs:offline-binding";
const OFFLINE_ACCESS_KEY = "hiai-docs:offline-access-enabled";
const MAX_BINDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type OfflineIdentityResolution =
	| { kind: "verified-authenticated"; identity: OfflineIdentity }
	| { kind: "offline-bound"; identity: OfflineIdentity; verifiedAt: string }
	| { kind: "verified-unauthenticated" }
	| { kind: "unavailable" };

function config() {
	return {
		appId: import.meta.env.VITE_APP_ID ?? "hiai-docs",
		deploymentId: import.meta.env.VITE_DEPLOYMENT_ID ?? "hiai-docs-pwa-local",
	};
}

function isNetworkFailure(error: unknown): boolean {
	return (
		error instanceof TypeError ||
		(typeof navigator !== "undefined" && !navigator.onLine)
	);
}

export function offlineAccessEnabled(): boolean {
	return (
		typeof localStorage !== "undefined" &&
		localStorage.getItem(OFFLINE_ACCESS_KEY) === "1"
	);
}

export function enableOfflineAccess(identity: OfflineIdentity): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(OFFLINE_ACCESS_KEY, "1");
	localStorage.setItem(
		OFFLINE_BINDING_KEY,
		JSON.stringify({ identity, verifiedAt: new Date().toISOString() }),
	);
}

export function disableOfflineAccess(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.removeItem(OFFLINE_ACCESS_KEY);
	localStorage.removeItem(OFFLINE_BINDING_KEY);
	localStorage.removeItem(OWNER_ID_CACHE_KEY);
}

function readBinding(): {
	identity: OfflineIdentity;
	verifiedAt: string;
} | null {
	if (!offlineAccessEnabled() || typeof localStorage === "undefined")
		return null;
	try {
		const value = JSON.parse(
			localStorage.getItem(OFFLINE_BINDING_KEY) ?? "null",
		) as { identity?: OfflineIdentity; verifiedAt?: string } | null;
		if (!value?.identity?.ownerId || !value.verifiedAt) return null;
		if (Date.now() - Date.parse(value.verifiedAt) > MAX_BINDING_AGE_MS)
			return null;
		return { identity: value.identity, verifiedAt: value.verifiedAt };
	} catch {
		return null;
	}
}

/**
 * Build the IndexedDB database name for a given identity. The name encodes
 * every scoping dimension so two different users (or deployments) never
 * share the same on-disk database.
 */
export function offlineDbName(identity: OfflineIdentity): string {
	return `hiai-docs-offline::${identity.appId}::${identity.deploymentId}::${identity.ownerId}::${identity.tenantId ?? "none"}`;
}

/**
 * Resolve the current offline identity from the environment and the active
 * Better Auth session.
 *
 * `getSession()` is async, so this function is async too (the plan's sync
 * signature is adjusted because the session is only available via an
 * async call). When offline (or not yet authenticated) we fall back to a
 * locally cached owner id so the DB can still be scoped consistently.
 */
export async function resolveOfflineIdentityResolution(): Promise<OfflineIdentityResolution> {
	const { appId, deploymentId } = config();
	try {
		const { data } = await getSession();
		if (!data?.user?.id) {
			disableOfflineAccess();
			return { kind: "verified-unauthenticated" };
		}
		const identity = {
			appId,
			deploymentId,
			ownerId: data.user.id,
			tenantId: undefined,
		};
		if (typeof localStorage !== "undefined")
			localStorage.setItem(OWNER_ID_CACHE_KEY, identity.ownerId);
		if (offlineAccessEnabled()) enableOfflineAccess(identity);
		return { kind: "verified-authenticated", identity };
	} catch (error) {
		const binding = isNetworkFailure(error) ? readBinding() : null;
		return binding
			? { kind: "offline-bound", ...binding }
			: { kind: "unavailable" };
	}
}

/** Resolve a usable partition; never returns an anonymous or stale owner. */
export async function resolveOfflineIdentity(): Promise<OfflineIdentity> {
	const result = await resolveOfflineIdentityResolution();
	if (
		result.kind === "verified-authenticated" ||
		result.kind === "offline-bound"
	)
		return result.identity;
	throw new Error("Offline identity unavailable");
}
