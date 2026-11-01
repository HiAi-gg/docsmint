import "fake-indexeddb/auto";

if (typeof globalThis.localStorage === "undefined") {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
			clear: () => values.clear(),
		},
	});
}

import {
	enableOfflineAccess,
	type OfflineIdentity,
} from "#lib/offline/identity.js";

export const testIdentity: OfflineIdentity = {
	appId: "hiai-docs",
	deploymentId: "hiai-docs-pwa-local",
	ownerId: "offline-test-owner",
	tenantId: undefined,
};

export function prepareOfflineIdentity(): OfflineIdentity {
	enableOfflineAccess(testIdentity);
	return testIdentity;
}
