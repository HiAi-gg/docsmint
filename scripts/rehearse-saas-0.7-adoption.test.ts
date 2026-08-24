import { describe, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";

import {
	redactSecrets,
	runRehearsalWorkflow,
	startIsolatedRedisServer,
	stopIsolatedRedisServer,
	validateTemporaryRoot,
	verifyAdditiveMigrationReapply,
	verifyAtomicAdoption,
	verifyCandidateProvenance,
	verifyNoNewRequiredEnvironment,
	verifyRuntimeSmoke,
	verifySaasBaseline,
} from "./rehearse-saas-0.7-adoption";

async function redisCli(
	port: number,
	database: number,
	...arguments_: string[]
): Promise<string> {
	const child = Bun.spawn(
		[
			"redis-cli",
			"-h",
			"127.0.0.1",
			"-p",
			String(port),
			"-n",
			String(database),
			...arguments_,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trim();
}

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
			packageGitHead: expectedCandidate,
			tarballSha256: "c".repeat(64),
			verifiedTarballSha256: "c".repeat(64),
			provenanceRecord: {
				candidateCommit: expectedCandidate,
				packageGitHead: expectedCandidate,
				tarballSha256: "c".repeat(64),
			},
			submoduleCommit: expectedCandidate,
			commitFiles: [
				...packageManifests,
				"bun.lock",
				"docsmint-oss",
				".docsmint-oss-adoption.json",
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
		expect(() =>
			verifyAtomicAdoption(
				{ ...evidence, packageGitHead: "d".repeat(40) },
				{ candidateCommit: expectedCandidate, packageManifests },
			),
		).toThrow("package provenance");
		expect(() =>
			verifyAtomicAdoption(
				{ ...evidence, verifiedTarballSha256: "d".repeat(64) },
				{ candidateCommit: expectedCandidate, packageManifests },
			),
		).toThrow("tarball content hash");
		expect(() =>
			verifyAtomicAdoption(
				{
					...evidence,
					provenanceRecord: {
						...evidence.provenanceRecord,
						candidateCommit: "d".repeat(40),
					},
				},
				{ candidateCommit: expectedCandidate, packageManifests },
			),
		).toThrow("adoption provenance record");
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

	test("keeps foreign Redis keys after old lease ownership is lost", async () => {
		const root = `/tmp/docsmint-saas-adoption-${crypto.randomUUID().replaceAll("-", "")}`;
		const foreignKey = `foreign:${crypto.randomUUID()}`;
		const staleLeaseKey = `old-rehearsal-lease:${crypto.randomUUID()}`;
		await mkdir(root);
		let foreign:
			| Awaited<ReturnType<typeof startIsolatedRedisServer>>
			| undefined;
		let isolated:
			| Awaited<ReturnType<typeof startIsolatedRedisServer>>
			| undefined;
		try {
			foreign = await startIsolatedRedisServer(root);
			expect(
				await redisCli(foreign.port, 15, "SET", foreignKey, "survives", "EX", "120"),
			).toBe("OK");
			expect(
				await redisCli(
					foreign.port,
					15,
					"SET",
					staleLeaseKey,
					"expired",
					"EX",
					"120",
				),
			).toBe("OK");
			isolated = await startIsolatedRedisServer(root);
			const owned = Bun.spawn(
				["redis-cli", "-u", isolated.url, "SET", "bull:owned", "value"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(await owned.exited).toBe(0);
			expect(await redisCli(foreign.port, 15, "DEL", staleLeaseKey)).toBe("1");

			await stopIsolatedRedisServer(isolated);
			isolated = undefined;

			expect(await redisCli(foreign.port, 15, "GET", foreignKey)).toBe(
				"survives",
			);
		} finally {
			if (isolated)
				await stopIsolatedRedisServer(isolated).catch(() => undefined);
			if (foreign) {
				await redisCli(foreign.port, 15, "DEL", foreignKey, staleLeaseKey).catch(
					() => undefined,
				);
				await stopIsolatedRedisServer(foreign).catch(() => undefined);
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	test("resolves rehearsal dependencies from the active Compose project", async () => {
		const resolveComposeServiceContainer = (
			await import("./rehearse-saas-0.7-adoption")
				.catch(() => undefined) as unknown as
					| {
							resolveComposeServiceContainer?: (
								service: string,
								environment: Record<string, string>,
							) => Promise<string>;
						}
					| undefined
		)?.resolveComposeServiceContainer;
		expect(typeof resolveComposeServiceContainer).toBe("function");
		if (!resolveComposeServiceContainer) return;

		const root = `/tmp/docsmint-saas-adoption-${crypto.randomUUID().replaceAll("-", "")}`;
		const bin = `${root}/bin`;
		await mkdir(bin, { recursive: true });
		const docker = `${bin}/docker`;
		await Bun.write(
			docker,
			[
				"#!/bin/sh",
				'test "$1" = "compose"',
				'test "$2" = "--env-file"',
				'test "$3" = "/dev/null"',
				'test "$4" = "ps"',
				'test "$5" = "--quiet"',
				'case "$6" in',
				"  postgres) echo active-project-postgres-1 ;;",
				"  seaweedfs) echo active-project-seaweedfs-1 ;;",
				"  *) exit 9 ;;",
				"esac",
			].join("\n"),
		);
		await chmod(docker, 0o700);
		try {
			expect(
				await resolveComposeServiceContainer("postgres", {
					PATH: `${bin}:/usr/bin:/bin`,
				}),
			).toBe("active-project-postgres-1");
			expect(
				await resolveComposeServiceContainer("seaweedfs", {
					PATH: `${bin}:/usr/bin:/bin`,
				}),
			).toBe("active-project-seaweedfs-1");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects dirty or mismatched OSS candidate provenance before packing", () => {
		const clean = {
			candidateCommit: "a".repeat(40),
			headCommit: "a".repeat(40),
			headTree: "b".repeat(40),
			indexTree: "b".repeat(40),
			status: "",
			submoduleStatus: [] as string[],
		};

		expect(verifyCandidateProvenance(clean)).toEqual({
			commit: "a".repeat(40),
			tree: "b".repeat(40),
		});
		expect(() =>
			verifyCandidateProvenance({ ...clean, status: " M package.public.json" }),
		).toThrow("candidate checkout is not clean");
		expect(() =>
			verifyCandidateProvenance({
				...clean,
				status: "?? packages/sdk/src/injected.ts",
			}),
		).toThrow("candidate checkout is not clean");
		expect(() =>
			verifyCandidateProvenance({ ...clean, headCommit: "c".repeat(40) }),
		).toThrow("candidate HEAD does not match");
		expect(() =>
			verifyCandidateProvenance({ ...clean, indexTree: "c".repeat(40) }),
		).toThrow("candidate index does not match");
	});

	test("rejects a mixed or mutable 0.6.8 SaaS baseline", () => {
		const manifests = {
			"package.json": "0.6.8",
			"apps/api/package.json": "0.6.8",
			"apps/web/package.json": "0.6.8",
			"packages/cli/package.json": "0.6.8",
			"packages/mcp/package.json": "0.6.8",
		};
		const baseline = {
			expectedCommit: "a".repeat(40),
			baseCommit: "a".repeat(40),
			packageVersions: manifests,
			lockfileVersion: "0.6.8",
			launcherVersion: "0.6.8",
			gitlinkCommit: "b".repeat(40),
			submoduleCommit: "b".repeat(40),
			expectedSubmoduleCommit: "b".repeat(40),
		};

		expect(verifySaasBaseline(baseline)).toEqual({
			commit: "a".repeat(40),
			version: "0.6.8",
		});
		for (const mutation of [
			{ baseCommit: "c".repeat(40) },
			{
				packageVersions: { ...manifests, "apps/api/package.json": "0.7.0" },
			},
			{ lockfileVersion: "0.7.0" },
			{ launcherVersion: "0.7.0" },
			{ gitlinkCommit: "c".repeat(40) },
			{ submoduleCommit: "c".repeat(40) },
		]) {
			expect(() => verifySaasBaseline({ ...baseline, ...mutation })).toThrow(
				"exact SaaS 0.6.8 baseline",
			);
		}
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
			packageGitHead: "b".repeat(40),
			tarballSha256: "c".repeat(64),
			verifiedTarballSha256: "c".repeat(64),
			provenanceRecord: {
				candidateCommit: "b".repeat(40),
				packageGitHead: "b".repeat(40),
				tarballSha256: "c".repeat(64),
			},
			submoduleCommit: "b".repeat(40),
			commitFiles: [
				"package.json",
				"bun.lock",
				"docsmint-oss",
				".docsmint-oss-adoption.json",
			],
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
