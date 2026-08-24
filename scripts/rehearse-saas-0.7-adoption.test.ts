import { describe, expect, test } from "bun:test";

import {
	redactSecrets,
	runRehearsalWorkflow,
	validateTemporaryRoot,
	verifyAdditiveMigrationReapply,
	verifyAtomicAdoption,
	verifyNoNewRequiredEnvironment,
	verifyRuntimeSmoke,
} from "./rehearse-saas-0.7-adoption";

describe("DocsMint SaaS 0.7 adoption rehearsal", () => {
	test("reapplies the additive migration as an idempotent no-op", () => {
		const before = {
			journalEntries: 43,
			schemaFingerprint: "legacy-schema",
			columns: [] as string[],
		};
		const afterFirst = {
			journalEntries: 44,
			schemaFingerprint: "embedding-context-schema",
			columns: [
				"document_pipeline_runs.embedding_context_hash:text:YES:",
				"document_pipeline_runs.refresh_mode:text:NO:'full'::text",
				"documents.embedding_context_hash:text:YES:",
			],
		};
		const afterSecond = structuredClone(afterFirst);

		expect(
			verifyAdditiveMigrationReapply(before, afterFirst, afterSecond),
		).toEqual({ addedJournalEntries: 1, secondRunNoOp: true });
		expect(() =>
			verifyAdditiveMigrationReapply(before, afterFirst, {
				...afterSecond,
				journalEntries: 45,
			}),
		).toThrow("second migration run changed the journal or schema");
		expect(() =>
			verifyAdditiveMigrationReapply(
				before,
				{ ...afterFirst, columns: ["wrong", "columns", "only"] },
				afterSecond,
			),
		).toThrow("expected additive columns");
	});

	test("requires no new environment variables relative to 0.6.8", () => {
		const baseline = {
			accepted: true,
			requiredKeys: [
				"API_KEY_ENCRYPTION_SECRET",
				"BETTER_AUTH_SECRET",
				"CSRF_SECRET",
				"HIAI_DOCS_API_KEY",
				"STORAGE_SECRET_KEY",
				"WEBHOOK_SECRET",
			],
		};
		const candidate = { ...baseline, requiredKeys: [...baseline.requiredKeys] };

		expect(verifyNoNewRequiredEnvironment(baseline, candidate)).toEqual({
			baselineRequiredKeys: baseline.requiredKeys,
			candidateRequiredKeys: baseline.requiredKeys,
			newRequiredKeys: [],
		});
		expect(() =>
			verifyNoNewRequiredEnvironment(baseline, {
				accepted: true,
				requiredKeys: [...baseline.requiredKeys, "NEW_REQUIRED_SECRET"],
			}),
		).toThrow("0.7 requires new environment variables: NEW_REQUIRED_SECRET");
	});

	test("adopts the package and submodule atomically in a disposable SaaS copy", () => {
		const packageManifests = [
			"package.json",
			"apps/api/package.json",
			"apps/web/package.json",
			"packages/cli/package.json",
			"packages/mcp/package.json",
		];
		const expectedCommit = "a".repeat(40);
		const expectedCandidate = "b".repeat(40);
		const evidence = {
			adoptionCommit: expectedCommit,
			candidateCommit: expectedCandidate,
			packageVersions: Object.fromEntries(
				packageManifests.map((path) => [path, "0.7.0"]),
			),
			lockfileVersion: "0.7.0",
			localTarballResolved: true,
			submoduleCommit: expectedCandidate,
			commitFiles: [
				...packageManifests,
				"bun.lock",
				"docsmint-oss",
				"apps/api/src/lib/oss-034-quota-launcher.ts",
			],
		};

		expect(
			verifyAtomicAdoption(evidence, {
				candidateCommit: expectedCandidate,
				packageManifests,
			}),
		).toEqual({ adoptionCommit: expectedCommit, version: "0.7.0" });
		expect(() =>
			verifyAtomicAdoption(
				{
					...evidence,
					commitFiles: evidence.commitFiles.filter(
						(path) => path !== "docsmint-oss",
					),
				},
				{ candidateCommit: expectedCandidate, packageManifests },
			),
		).toThrow("atomic adoption commit is missing docsmint-oss");
		expect(() =>
			verifyAtomicAdoption(
				{ ...evidence, localTarballResolved: false },
				{ candidateCommit: expectedCandidate, packageManifests },
			),
		).toThrow("local packed OSS candidate");
	});

	test("smokes the 0.7 runtime against the upgraded disposable database", () => {
		const evidence = {
			version: "0.7.0",
			health: true,
			crud: { create: true, read: true, update: true, delete: true },
			search: true,
			assertionScope: {
				allowedDocumentVisible: true,
				foreignDocumentHidden: true,
			},
		};

		expect(
			verifyRuntimeSmoke(evidence, { requireAssertionScope: true }),
		).toEqual({
			version: "0.7.0",
			passed: true,
		});
		expect(() =>
			verifyRuntimeSmoke(
				{
					...evidence,
					assertionScope: {
						allowedDocumentVisible: true,
						foreignDocumentHidden: false,
					},
				},
				{ requireAssertionScope: true },
			),
		).toThrow("0.7.0 assertion scope smoke failed");
	});

	test("smokes the 0.6.8 runtime against the upgraded disposable database", () => {
		const evidence = {
			version: "0.6.8",
			health: true,
			crud: { create: true, read: true, update: true, delete: true },
			search: true,
		};

		expect(
			verifyRuntimeSmoke(evidence, { requireAssertionScope: false }),
		).toEqual({
			version: "0.6.8",
			passed: true,
		});
		expect(() =>
			verifyRuntimeSmoke(
				{ ...evidence, search: false },
				{ requireAssertionScope: false },
			),
		).toThrow("0.6.8 runtime smoke failed: search");
	});

	test("rejects cleanup paths outside the unique rehearsal root and redacts secrets", () => {
		const root = "/tmp/docsmint-saas-adoption-7dbb88a0";
		expect(validateTemporaryRoot(root)).toBe(root);
		expect(() => validateTemporaryRoot("/tmp/docsmint-saas-adoption")).toThrow(
			"unique validated /tmp root",
		);
		expect(() => validateTemporaryRoot("/mnt/data/projects/docsmint")).toThrow(
			"unique validated /tmp root",
		);
		expect(
			redactSecrets("token-a password-b token-a", ["token-a", "password-b"]),
		).toBe("[REDACTED] [REDACTED] [REDACTED]");
	});

	test("orders the real rehearsal gates and always cleans isolated resources", async () => {
		const events: string[] = [];
		const migrationBefore = {
			journalEntries: 43,
			schemaFingerprint: "before",
			columns: [],
		};
		const migrationAfter = {
			journalEntries: 44,
			schemaFingerprint: "after",
			columns: [
				"document_pipeline_runs.embedding_context_hash:text:YES:",
				"document_pipeline_runs.refresh_mode:text:NO:'full'::text",
				"documents.embedding_context_hash:text:YES:",
			],
		};
		const environment = {
			accepted: true,
			requiredKeys: ["BETTER_AUTH_SECRET"],
		};
		const runtime070 = {
			version: "0.7.0",
			health: true,
			crud: { create: true, read: true, update: true, delete: true },
			search: true,
			assertionScope: {
				allowedDocumentVisible: true,
				foreignDocumentHidden: true,
			},
		};
		const runtime068 = {
			version: "0.6.8",
			health: true,
			crud: { create: true, read: true, update: true, delete: true },
			search: true,
		};
		const adoption = {
			adoptionCommit: "a".repeat(40),
			candidateCommit: "b".repeat(40),
			packageVersions: { "package.json": "0.7.0" },
			lockfileVersion: "0.7.0",
			localTarballResolved: true,
			submoduleCommit: "b".repeat(40),
			commitFiles: ["package.json", "bun.lock", "docsmint-oss"],
		};

		const report = await runRehearsalWorkflow(
			{
				assertRealCheckoutClean: async (phase) => events.push(`clean:${phase}`),
				prepare: async () => {
					events.push("prepare");
					return { root: "/tmp/docsmint-saas-adoption-deadbeef" };
				},
				packAndAdopt: async () => {
					events.push("adopt");
					return adoption;
				},
				migrate: async () => {
					events.push("migrate");
					return {
						before: migrationBefore,
						afterFirst: migrationAfter,
						afterSecond: structuredClone(migrationAfter),
					};
				},
				probeEnvironment: async () => {
					events.push("environment");
					return {
						baseline: environment,
						candidate: structuredClone(environment),
					};
				},
				smoke070: async () => {
					events.push("smoke:0.7.0");
					return runtime070;
				},
				smoke068: async () => {
					events.push("smoke:0.6.8");
					return runtime068;
				},
				cleanup: async () => events.push("cleanup"),
			},
			{ candidateCommit: "b".repeat(40), packageManifests: ["package.json"] },
		);

		expect(report.runtime070.version).toBe("0.7.0");
		expect(report.runtime068.version).toBe("0.6.8");
		expect(events).toEqual([
			"clean:before",
			"prepare",
			"adopt",
			"migrate",
			"environment",
			"smoke:0.7.0",
			"smoke:0.6.8",
			"cleanup",
			"clean:after",
		]);

		events.length = 0;
		await expect(
			runRehearsalWorkflow(
				{
					assertRealCheckoutClean: async (phase) =>
						events.push(`clean:${phase}`),
					prepare: async () => {
						events.push("prepare");
						return { root: "/tmp/docsmint-saas-adoption-feedface" };
					},
					packAndAdopt: async () => {
						throw new Error("adoption failed");
					},
					migrate: async () => {
						throw new Error("not reached");
					},
					probeEnvironment: async () => {
						throw new Error("not reached");
					},
					smoke070: async () => {
						throw new Error("not reached");
					},
					smoke068: async () => {
						throw new Error("not reached");
					},
					cleanup: async () => events.push("cleanup"),
				},
				{ candidateCommit: "b".repeat(40), packageManifests: ["package.json"] },
			),
		).rejects.toThrow("adoption failed");
		expect(events).toEqual([
			"clean:before",
			"prepare",
			"cleanup",
			"clean:after",
		]);
	});
});
