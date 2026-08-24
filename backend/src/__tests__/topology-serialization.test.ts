import { describe, expect, test } from "bun:test";

import {
	tenantTopologyLockIdentity,
	tenantTopologyLockKey,
} from "../lib/topology-serialization";

describe("tenant topology lock identity", () => {
	test("is deterministic, collision-resistant across context kinds, and tenant-scoped", () => {
		const personalA = {
			userId: "owner:workspace-a",
			role: "user" as const,
			source: "personal" as const,
		};
		const personalB = {
			userId: "owner",
			role: "user" as const,
			source: "personal" as const,
		};
		const workspaceActorA = {
			userId: "actor-a",
			role: "user" as const,
			source: "external" as const,
			workspaceId: "workspace-a",
		};
		const workspaceActorB = {
			userId: "actor-b",
			role: "user" as const,
			source: "external" as const,
			workspaceId: "workspace-a",
		};
		const workspaceB = {
			...workspaceActorA,
			workspaceId: "workspace-a:actor-a",
		};

		expect(tenantTopologyLockIdentity(personalA)).toBe(
			tenantTopologyLockIdentity(personalA),
		);
		expect(tenantTopologyLockKey(personalA)).toBe(
			tenantTopologyLockKey(personalA),
		);
		expect(tenantTopologyLockIdentity(personalA)).not.toBe(
			tenantTopologyLockIdentity(personalB),
		);
		expect(tenantTopologyLockIdentity(personalA)).not.toBe(
			tenantTopologyLockIdentity(workspaceActorA),
		);
		expect(tenantTopologyLockIdentity(workspaceActorA)).toBe(
			tenantTopologyLockIdentity(workspaceActorB),
		);
		expect(tenantTopologyLockIdentity(workspaceActorA)).not.toBe(
			tenantTopologyLockIdentity(workspaceB),
		);
		expect(tenantTopologyLockKey(personalA)).not.toBe(
			tenantTopologyLockKey(workspaceActorA),
		);
		expect(tenantTopologyLockKey(workspaceActorA)).not.toBe(
			tenantTopologyLockKey(workspaceB),
		);
		expect(tenantTopologyLockKey(personalA)).toBeGreaterThanOrEqual(
			-(1n << 63n),
		);
		expect(tenantTopologyLockKey(personalA)).toBeLessThan(1n << 63n);
	});
});
