import { describe, expect, test } from "bun:test";
import { chmod, mkdir, rm } from "node:fs/promises";

import {
	attachmentStorageEnforcementForRuntimeVersion,
	disposableRehearsalBuckets,
	validateHostSourceRootEvidence,
	validateOssSourceRootEvidence,
	type IsolatedRedisServer,
	redactSecrets,
	migrationJournalEntryCount,
	runRehearsalWorkflow,
	stopIsolatedRedisServer,
	updateQuotaLauncherPin,
	validateTemporaryRoot,
	verifyAdditiveMigrationReapply,
	verifyAtomicAdoption,
	verifyCandidateProvenance,
	verifyHostBaseline,
	verifyNoNewRequiredEnvironment,
	verifyRuntimeSmoke,
	workspaceEnabledForRuntimeVersion,
} from "./rehearse-host-0.7-adoption";

describe("DocsMint host 0.7 adoption rehearsal", () => {
	test("validates an explicit clean SaaS source at the exact baseline", () => {
		const path = "/tmp/docsmint-host-source-090";
		const valid = {
			path,
			repositoryRoot: path,
			hostCommit: "31485e6679608a762b6fda4a8ee8f97afbf76577",
			gitlinkCommit: "ea83e5380596567434545ac2a34f65d241a9e75b",
			submoduleCommit: "ea83e5380596567434545ac2a34f65d241a9e75b",
			status: "",
		};

		expect(validateHostSourceRootEvidence(valid)).toBe(path);
		expect(() =>
			validateHostSourceRootEvidence({ ...valid, path: "relative/source" }),
		).toThrow("absolute");
		expect(() =>
			validateHostSourceRootEvidence({ ...valid, repositoryRoot: "/tmp/other" }),
		).toThrow("Git repository root");
		expect(() =>
			validateHostSourceRootEvidence({ ...valid, hostCommit: "0".repeat(40) }),
		).toThrow("baseline commit");
		expect(() =>
			validateHostSourceRootEvidence({ ...valid, submoduleCommit: "0".repeat(40) }),
		).toThrow("baseline OSS submodule");
		expect(() =>
			validateHostSourceRootEvidence({ ...valid, status: " M README.md" }),
		).toThrow("clean");
	});
	test("validates the OSS source at the exact release candidate commit", () => {
		const path = "/tmp/docsmint-oss-source-090";
		const expectedCommit = "b".repeat(40);
		const valid = {
			path,
			repositoryRoot: path,
			commit: expectedCommit,
			status: "",
		};

		expect(validateOssSourceRootEvidence(valid, expectedCommit)).toBe(path);
		expect(() =>
			validateOssSourceRootEvidence(
				{ ...valid, path: "relative/source" },
				expectedCommit,
			),
		).toThrow("absolute");
		expect(() =>
			validateOssSourceRootEvidence(
				{ ...valid, repositoryRoot: "/tmp/other" },
				expectedCommit,
			),
		).toThrow("Git repository root");
		expect(() =>
			validateOssSourceRootEvidence(
				{ ...valid, commit: "0".repeat(40) },
				expectedCommit,
			),
		).toThrow("candidate commit");
		expect(() =>
			validateOssSourceRootEvidence(
				{ ...valid, status: " M package.json" },
				expectedCommit,
			),
		).toThrow("clean");
	});

	test("runs the 0.6.8 attachment rollback smoke through the quota-aware runtime", () => {
		expect(workspaceEnabledForRuntimeVersion("0.6.8")).toBe("true");
		expect(attachmentStorageEnforcementForRuntimeVersion("0.6.8")).toBe(
			"true",
		);
		expect(workspaceEnabledForRuntimeVersion("0.7.0")).toBe("true");
		expect(attachmentStorageEnforcementForRuntimeVersion("0.7.0")).toBe(
			"true",
		);
		expect(workspaceEnabledForRuntimeVersion("0.7.1")).toBe("true");
		expect(attachmentStorageEnforcementForRuntimeVersion("0.7.1")).toBe(
			"true",
		);
		expect(workspaceEnabledForRuntimeVersion("0.7.2")).toBe("true");
		expect(attachmentStorageEnforcementForRuntimeVersion("0.7.2")).toBe(
			"true",
		);
		expect(() => workspaceEnabledForRuntimeVersion("0.9.0")).toThrow(
			"unsupported rehearsal runtime version",
		);
		expect(() =>
			attachmentStorageEnforcementForRuntimeVersion("0.9.0"),
		).toThrow("unsupported rehearsal runtime version");
	});

	const withAttachmentCleanupColumns = (columns: string[]) =>
		[
			...columns,
			"attachment_storage_cleanup_outbox.actor_user_id:uuid:NO:",
			"attachment_storage_cleanup_outbox.attempt_count:integer:NO:0",
			"attachment_storage_cleanup_outbox.created_at:timestamp without time zone:NO:now()",
			"attachment_storage_cleanup_outbox.document_id:uuid:NO:",
			"attachment_storage_cleanup_outbox.id:uuid:NO:gen_random_uuid()",
			"attachment_storage_cleanup_outbox.last_error:text:YES:",
			"attachment_storage_cleanup_outbox.lease_expires_at:timestamp without time zone:YES:",
			"attachment_storage_cleanup_outbox.lease_owner:text:YES:",
			"attachment_storage_cleanup_outbox.not_before:timestamp without time zone:NO:now()",
			"attachment_storage_cleanup_outbox.object_deleted_at:timestamp without time zone:YES:",
			"attachment_storage_cleanup_outbox.owner_user_id:uuid:NO:",
			"attachment_storage_cleanup_outbox.quota_operation_key:text:NO:",
			"attachment_storage_cleanup_outbox.quota_release_kind:text:NO:'none'::text",
			"attachment_storage_cleanup_outbox.quota_reservation_id:text:YES:",
			"attachment_storage_cleanup_outbox.requested_by_user_id:uuid:NO:",
			"attachment_storage_cleanup_outbox.retain_until:timestamp without time zone:YES:",
			"attachment_storage_cleanup_outbox.size:bigint:NO:",
			"attachment_storage_cleanup_outbox.source_id:uuid:NO:",
			"attachment_storage_cleanup_outbox.source_kind:text:NO:",
			"attachment_storage_cleanup_outbox.storage_key:text:NO:",
			"attachment_storage_cleanup_outbox.workspace_id:text:YES:",
			"pending_attachment_uploads.actual_size:bigint:YES:",
			"pending_attachment_uploads.attempt_count:integer:NO:0",
			"pending_attachment_uploads.last_error:text:YES:",
			"pending_attachment_uploads.lease_expires_at:timestamp without time zone:YES:",
			"pending_attachment_uploads.lease_owner:text:YES:",
			"pending_attachment_uploads.quota_operation_key:text:NO:",
			"pending_attachment_uploads.quota_state:text:NO:",
			"pending_attachment_uploads.url_issued_at:timestamp without time zone:YES:",
		].sort();

	test("reapplies the additive migration as an idempotent no-op", () => {
		const before = {
			journalEntries: 43,
			schemaFingerprint: "legacy-schema",
			columns: [] as string[],
		};
		const afterFirst = {
			journalEntries: 50,
			schemaFingerprint: "embedding-context-and-outbox-schema",
			columns: withAttachmentCleanupColumns([
				"attachments.uploaded_by:uuid:NO:",
				"document_pipeline_runs.embedding_context_hash:text:YES:",
				"document_pipeline_runs.refresh_mode:text:NO:'full'::text",
				"documents.embedding_context_hash:text:YES:",
				"metadata_reembed_outbox.created_at:timestamp without time zone:NO:now()",
				"metadata_reembed_outbox.document_id:uuid:NO:",
				"metadata_reembed_outbox.id:uuid:NO:",
				"metadata_reembed_outbox.operation_id:uuid:NO:",
				"metadata_reembed_outbox.owner_id:uuid:NO:",
				"metadata_reembed_outbox.revision:text:NO:",
				"metadata_reembed_outbox.workspace_id:text:YES:",
				"pending_attachment_uploads.actor_user_id:uuid:NO:",
				"pending_attachment_uploads.confirming_at:timestamp without time zone:YES:",
				"pending_attachment_uploads.created_at:timestamp without time zone:NO:now()",
				"pending_attachment_uploads.declared_size:bigint:NO:",
				"pending_attachment_uploads.document_id:uuid:NO:",
				"pending_attachment_uploads.expires_at:timestamp without time zone:NO:",
				"pending_attachment_uploads.filename:text:NO:",
				"pending_attachment_uploads.id:uuid:NO:gen_random_uuid()",
				"pending_attachment_uploads.mime_type:text:NO:",
				"pending_attachment_uploads.quota_reservation_id:text:YES:",
				"pending_attachment_uploads.storage_key:text:NO:",
				"pending_attachment_uploads.token_hash:text:NO:",
				"pending_attachment_uploads.workspace_id:text:YES:",
			]),
		};
		const afterSecond = structuredClone(afterFirst);

		expect(
			verifyAdditiveMigrationReapply(before, afterFirst, afterSecond, 7),
		).toEqual({ addedJournalEntries: 7, secondRunNoOp: true });
		expect(() =>
			verifyAdditiveMigrationReapply(before, afterFirst, {
				...afterSecond,
				journalEntries: 51,
			}, 7),
		).toThrow("second migration run changed the journal or schema");
		expect(() =>
			verifyAdditiveMigrationReapply(
				before,
				{
					...afterFirst,
					columns: ["wrong", ...afterFirst.columns.slice(1)],
				},
				afterSecond,
				7,
			),
		).toThrow("expected additive columns");
	});

	test("counts migration entries from validated candidate and baseline journals", () => {
		expect(
			migrationJournalEntryCount(
				JSON.stringify({ entries: Array.from({ length: 52 }, (_, idx) => idx) }),
			),
		).toBe(52);
		expect(() => migrationJournalEntryCount("{" )).toThrow("valid JSON");
		expect(() => migrationJournalEntryCount('{"entries":[]}')).toThrow(
			"no entries",
		);
	});

	test("updates only the disposable quota launcher to the exact candidate pin", () => {
		const launcher = [
			"export const OSS_QUOTA_LAUNCHER_VERSION = '0.6.8' as const;",
			"export function assertExactOssQuotaLauncherPin(version: string): asserts version is '0.6.8' {",
		].join("\n");
		const updated = updateQuotaLauncherPin(launcher, "0.9.0");
		expect(updated).toContain("OSS_QUOTA_LAUNCHER_VERSION = '0.9.0' as const");
		expect(updated).toContain("asserts version is '0.9.0'");
		expect(updated).not.toContain("'0.6.8'");
		expect(() => updateQuotaLauncherPin("export const VERSION = '0.8.1';", "0.9.0"))
			.toThrow("not pinned to baseline 0.6.8");
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

	test("adopts the package and submodule atomically in a disposable host copy", () => {
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
				packageManifests.map((path) => [path, "0.9.0"]),
			),
			lockfileVersion: "0.9.0",
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
				candidateVersion: "0.9.0",
				packageManifests,
			}),
		).toEqual({ adoptionCommit: expectedCommit, version: "0.9.0" });
		expect(() =>
			verifyAtomicAdoption(
				{
					...evidence,
					commitFiles: evidence.commitFiles.filter(
						(path) => path !== "docsmint-oss",
					),
				},
				{ candidateCommit: expectedCandidate, candidateVersion: "0.9.0", packageManifests },
			),
		).toThrow("atomic adoption commit is missing docsmint-oss");
		expect(() =>
			verifyAtomicAdoption(
				{ ...evidence, localTarballResolved: false },
				{ candidateCommit: expectedCandidate, candidateVersion: "0.9.0", packageManifests },
			),
		).toThrow("local packed OSS candidate");
		expect(() =>
			verifyAtomicAdoption(
				{
					...evidence,
					packageVersions: Object.fromEntries(
						packageManifests.map((path) => [path, "0.8.1"]),
					),
				},
				{ candidateCommit: expectedCandidate, candidateVersion: "0.9.0", packageManifests },
			),
		).toThrow("did not pin package.json to 0.9.0");
		expect(() =>
			verifyAtomicAdoption(
				{ ...evidence, packageGitHead: "d".repeat(40) },
				{ candidateCommit: expectedCandidate, candidateVersion: "0.9.0", packageManifests },
			),
		).toThrow("package provenance");
		expect(() =>
			verifyAtomicAdoption(
				{ ...evidence, verifiedTarballSha256: "d".repeat(64) },
				{ candidateCommit: expectedCandidate, candidateVersion: "0.9.0", packageManifests },
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
				{ candidateCommit: expectedCandidate, candidateVersion: "0.9.0", packageManifests },
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

	test("deletes the preferred temporary Seaweed bucket even when rehearsal falls back", () => {
		expect(
			disposableRehearsalBuckets({
				preferredBucket: "dm-rehearsal-preferred",
				selectedBucket: "hiai-docs",
				preferredCreated: true,
			}),
		).toEqual(["dm-rehearsal-preferred"]);
		expect(
			disposableRehearsalBuckets({
				preferredBucket: "dm-rehearsal-preferred",
				selectedBucket: "dm-rehearsal-preferred",
				preferredCreated: true,
			}),
		).toEqual(["dm-rehearsal-preferred"]);
		expect(
			disposableRehearsalBuckets({
				preferredBucket: "dm-rehearsal-preferred",
				selectedBucket: "hiai-docs",
				preferredCreated: false,
			}),
		).toEqual([]);
	});

	test("rejects cleanup paths outside the unique rehearsal root and redacts secrets", () => {
		const root = "/tmp/docsmint-host-adoption-7dbb88a0";
		expect(validateTemporaryRoot(root)).toBe(root);
		expect(() => validateTemporaryRoot("/tmp/docsmint-host-adoption")).toThrow(
			"unique validated /tmp root",
		);
		expect(() => validateTemporaryRoot("/mnt/data/projects/docsmint")).toThrow(
			"unique validated /tmp root",
		);
		expect(
			redactSecrets("token-a password-b token-a", ["token-a", "password-b"]),
		).toBe("[REDACTED] [REDACTED] [REDACTED]");
	});

	test("stopIsolatedRedisServer only kills its owned child and never flushes Redis", async () => {
		const source = await Bun.file(
			new URL("./rehearse-host-0.7-adoption.ts", import.meta.url),
		).text();
		expect(source).not.toContain("FLUSHALL");
		expect(source).not.toContain("FLUSHDB");
		const root = `/tmp/docsmint-host-adoption-${"a".repeat(24)}`;
		await mkdir(root, { recursive: true });
		const signals: string[] = [];
		try {
			const server: IsolatedRedisServer = {
				root,
				url: "redis://127.0.0.1:6390/0",
				port: 6390,
				child: {
					kill(signal?: string) {
						signals.push(signal ?? "SIGTERM");
					},
					exited: Promise.resolve(0),
				} as IsolatedRedisServer["child"],
				stdout: Promise.resolve(""),
				stderr: Promise.resolve(""),
				stopped: false,
			};
			await stopIsolatedRedisServer(server);
			expect(server.stopped).toBe(true);
			expect(signals).toEqual(["SIGTERM"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("resolves rehearsal dependencies from the active Compose project", async () => {
		const resolveComposeServiceContainer = (
			await import("./rehearse-host-0.7-adoption")
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

		const root = `/tmp/docsmint-host-adoption-${crypto.randomUUID().replaceAll("-", "")}`;
		const bin = `${root}/bin`;
		await mkdir(bin, { recursive: true });
		const docker = `${bin}/docker`;
		await Bun.write(
			docker,
			[
				"#!/bin/sh",
				"set -eu",
				'test "$1" = "ps"',
				'test "$2" = "--filter"',
				'test "$3" = "label=com.docker.compose.project=round1-fixture"',
				'test "$4" = "--filter"',
				'case "$5" in',
				"  label=com.docker.compose.service=postgres) service=postgres ;;",
				"  label=com.docker.compose.service=seaweedfs) service=seaweedfs ;;",
				"  *) exit 9 ;;",
				"esac",
				'test "$6" = "--format"',
				'test "$7" = "{{.ID}}"',
				'case "$service" in',
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
					COMPOSE_PROJECT_NAME: "round1-fixture",
				}),
			).toBe("active-project-postgres-1");
			expect(
				await resolveComposeServiceContainer("seaweedfs", {
					PATH: `${bin}:/usr/bin:/bin`,
					COMPOSE_PROJECT_NAME: "round1-fixture",
				}),
			).toBe("active-project-seaweedfs-1");
			await expect(
				resolveComposeServiceContainer("postgres", {
					PATH: `${bin}:/usr/bin:/bin`,
				}),
			).rejects.toThrow("Compose project name");
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

	test("rejects a mixed or mutable 0.6.8 host baseline", () => {
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

		expect(verifyHostBaseline(baseline)).toEqual({
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
			expect(() => verifyHostBaseline({ ...baseline, ...mutation })).toThrow(
				"exact host 0.6.8 baseline",
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
			journalEntries: 50,
			schemaFingerprint: "after",
			columns: withAttachmentCleanupColumns([
				"attachments.uploaded_by:uuid:NO:",
				"document_pipeline_runs.embedding_context_hash:text:YES:",
				"document_pipeline_runs.refresh_mode:text:NO:'full'::text",
				"documents.embedding_context_hash:text:YES:",
				"metadata_reembed_outbox.created_at:timestamp without time zone:NO:now()",
				"metadata_reembed_outbox.document_id:uuid:NO:",
				"metadata_reembed_outbox.id:uuid:NO:",
				"metadata_reembed_outbox.operation_id:uuid:NO:",
				"metadata_reembed_outbox.owner_id:uuid:NO:",
				"metadata_reembed_outbox.revision:text:NO:",
				"metadata_reembed_outbox.workspace_id:text:YES:",
				"pending_attachment_uploads.actor_user_id:uuid:NO:",
				"pending_attachment_uploads.confirming_at:timestamp without time zone:YES:",
				"pending_attachment_uploads.created_at:timestamp without time zone:NO:now()",
				"pending_attachment_uploads.declared_size:bigint:NO:",
				"pending_attachment_uploads.document_id:uuid:NO:",
				"pending_attachment_uploads.expires_at:timestamp without time zone:NO:",
				"pending_attachment_uploads.filename:text:NO:",
				"pending_attachment_uploads.id:uuid:NO:gen_random_uuid()",
				"pending_attachment_uploads.mime_type:text:NO:",
				"pending_attachment_uploads.quota_reservation_id:text:YES:",
				"pending_attachment_uploads.storage_key:text:NO:",
				"pending_attachment_uploads.token_hash:text:NO:",
				"pending_attachment_uploads.workspace_id:text:YES:",
			]),
		};
		const environment = {
			accepted: true,
			requiredKeys: ["BETTER_AUTH_SECRET"],
		};
		const runtime070 = {
			version: "0.9.0",
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
			packageVersions: { "package.json": "0.9.0" },
			lockfileVersion: "0.9.0",
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
				assertRealCheckoutClean: async (phase) => {
					events.push(`clean:${phase}`);
				},
				prepare: async () => {
					events.push("prepare");
					return { root: "/tmp/docsmint-host-adoption-deadbeef" };
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
				cleanup: async () => {
					events.push("cleanup");
				},
			},
			{
				candidateCommit: "b".repeat(40),
				candidateVersion: "0.9.0",
				expectedAddedJournalEntries: 7,
				packageManifests: ["package.json"],
			},
		);

		expect(report.runtime070.version).toBe("0.9.0");
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
					assertRealCheckoutClean: async (phase) => {
						events.push(`clean:${phase}`);
					},
					prepare: async () => {
						events.push("prepare");
						return { root: "/tmp/docsmint-host-adoption-feedface" };
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
					cleanup: async () => {
						events.push("cleanup");
					},
				},
				{
					candidateCommit: "b".repeat(40),
					candidateVersion: "0.9.0",
					expectedAddedJournalEntries: 7,
					packageManifests: ["package.json"],
				},
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
