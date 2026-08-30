import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import postgres from "postgres";

const OSS_CANDIDATE_VERSION = "0.7.7";

export interface MigrationSnapshot {
	journalEntries: number;
	schemaFingerprint: string;
	columns: string[];
}

export interface EnvironmentProbe {
	accepted: boolean;
	requiredKeys: string[];
	issues?: string[];
}

export interface AtomicAdoptionEvidence {
	adoptionCommit: string;
	candidateCommit: string;
	packageVersions: Record<string, string>;
	lockfileVersion: string;
	localTarballResolved: boolean;
	packageGitHead: string;
	tarballSha256: string;
	verifiedTarballSha256: string;
	provenanceRecord: {
		candidateCommit: string;
		packageGitHead: string;
		tarballSha256: string;
	};
	submoduleCommit: string;
	commitFiles: string[];
}

export interface RuntimeSmokeEvidence {
	version: string;
	health: boolean;
	crud: {
		create: boolean;
		read: boolean;
		update: boolean;
		delete: boolean;
	};
	search: boolean;
	assertionScope?: {
		allowedDocumentVisible: boolean;
		foreignDocumentHidden: boolean;
	};
}

export interface CandidateProvenanceEvidence {
	candidateCommit: string;
	headCommit: string;
	headTree: string;
	indexTree: string;
	status: string;
	submoduleStatus: string[];
}

export interface HostBaselineEvidence {
	expectedCommit: string;
	baseCommit: string;
	packageVersions: Record<string, string>;
	lockfileVersion: string;
	launcherVersion: string;
	gitlinkCommit: string;
	submoduleCommit: string;
	expectedSubmoduleCommit: string;
}

export interface IsolatedRedisServer {
	root: string;
	url: string;
	port: number;
	child: ReturnType<typeof Bun.spawn>;
	stdout: Promise<string>;
	stderr: Promise<string>;
	stopped: boolean;
}

export interface PreparedRehearsal {
	root: string;
}

export interface RehearsalWorkflowOperations<
	TPrepared extends PreparedRehearsal,
> {
	assertRealCheckoutClean(phase: "before" | "after"): Promise<void>;
	prepare(): Promise<TPrepared>;
	packAndAdopt(prepared: TPrepared): Promise<AtomicAdoptionEvidence>;
	migrate(prepared: TPrepared): Promise<{
		before: MigrationSnapshot;
		afterFirst: MigrationSnapshot;
		afterSecond: MigrationSnapshot;
	}>;
	probeEnvironment(prepared: TPrepared): Promise<{
		baseline: EnvironmentProbe;
		candidate: EnvironmentProbe;
	}>;
	smoke070(prepared: TPrepared): Promise<RuntimeSmokeEvidence>;
	smoke068(prepared: TPrepared): Promise<RuntimeSmokeEvidence>;
	cleanup(prepared: TPrepared): Promise<void>;
}

export interface RehearsalWorkflowReport {
	adoption: AtomicAdoptionEvidence;
	migration: ReturnType<typeof verifyAdditiveMigrationReapply>;
	environment: ReturnType<typeof verifyNoNewRequiredEnvironment>;
	runtime070: RuntimeSmokeEvidence;
	runtime068: RuntimeSmokeEvidence;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TEMPORARY_ROOT_PATTERN = /^\/tmp\/docsmint-host-adoption-[0-9a-f]{8,64}$/;
const EXPECTED_ADDITIVE_JOURNAL_ENTRIES = 7;
const EXPECTED_ADDITIVE_COLUMNS = [
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
	"pending_attachment_uploads.actual_size:bigint:YES:",
	"pending_attachment_uploads.attempt_count:integer:NO:0",
	"pending_attachment_uploads.confirming_at:timestamp without time zone:YES:",
	"pending_attachment_uploads.created_at:timestamp without time zone:NO:now()",
	"pending_attachment_uploads.declared_size:bigint:NO:",
	"pending_attachment_uploads.document_id:uuid:NO:",
	"pending_attachment_uploads.expires_at:timestamp without time zone:NO:",
	"pending_attachment_uploads.filename:text:NO:",
	"pending_attachment_uploads.id:uuid:NO:gen_random_uuid()",
	"pending_attachment_uploads.last_error:text:YES:",
	"pending_attachment_uploads.lease_expires_at:timestamp without time zone:YES:",
	"pending_attachment_uploads.lease_owner:text:YES:",
	"pending_attachment_uploads.mime_type:text:NO:",
	"pending_attachment_uploads.quota_operation_key:text:NO:",
	"pending_attachment_uploads.quota_reservation_id:text:YES:",
	"pending_attachment_uploads.quota_state:text:NO:",
	"pending_attachment_uploads.storage_key:text:NO:",
	"pending_attachment_uploads.token_hash:text:NO:",
	"pending_attachment_uploads.url_issued_at:timestamp without time zone:YES:",
	"pending_attachment_uploads.workspace_id:text:YES:",
];

export function verifyCandidateProvenance(
	evidence: CandidateProvenanceEvidence,
): { commit: string; tree: string } {
	if (
		!COMMIT_PATTERN.test(evidence.candidateCommit) ||
		!COMMIT_PATTERN.test(evidence.headCommit) ||
		evidence.headCommit !== evidence.candidateCommit
	) {
		throw new Error("candidate HEAD does not match the recorded commit");
	}
	if (
		!COMMIT_PATTERN.test(evidence.headTree) ||
		!COMMIT_PATTERN.test(evidence.indexTree) ||
		evidence.headTree !== evidence.indexTree
	) {
		throw new Error("candidate index does not match the recorded commit tree");
	}
	if (evidence.status.length > 0) {
		throw new Error("candidate checkout is not clean");
	}
	if (evidence.submoduleStatus.some((line) => !line.startsWith(" "))) {
		throw new Error("candidate submodule state is not clean and initialized");
	}
	return { commit: evidence.candidateCommit, tree: evidence.headTree };
}

export function verifyHostBaseline(evidence: HostBaselineEvidence): {
	commit: string;
	version: "0.6.8";
} {
	const valid =
		COMMIT_PATTERN.test(evidence.expectedCommit) &&
		evidence.baseCommit === evidence.expectedCommit &&
		PACKAGE_MANIFESTS.every(
			(manifest) => evidence.packageVersions[manifest] === "0.6.8",
		) &&
		evidence.lockfileVersion === "0.6.8" &&
		evidence.launcherVersion === "0.6.8" &&
		evidence.gitlinkCommit === evidence.expectedSubmoduleCommit &&
		evidence.submoduleCommit === evidence.expectedSubmoduleCommit;
	if (!valid) throw new Error("exact host 0.6.8 baseline verification failed");
	return { commit: evidence.baseCommit, version: "0.6.8" };
}

export function validateTemporaryRoot(path: string): string {
	const normalized = resolve(path);
	if (normalized !== path || !TEMPORARY_ROOT_PATTERN.test(normalized)) {
		throw new Error("rehearsal requires a unique validated /tmp root");
	}
	return normalized;
}

export function redactSecrets(
	output: string,
	secrets: readonly string[],
): string {
	return [...new Set(secrets)]
		.filter((secret) => secret.length > 0)
		.sort((left, right) => right.length - left.length)
		.reduce(
			(redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
			output,
		);
}

export function verifyAdditiveMigrationReapply(
	before: MigrationSnapshot,
	afterFirst: MigrationSnapshot,
	afterSecond: MigrationSnapshot,
): { addedJournalEntries: number; secondRunNoOp: true } {
	const addedJournalEntries = afterFirst.journalEntries - before.journalEntries;
	if (
		addedJournalEntries !== EXPECTED_ADDITIVE_JOURNAL_ENTRIES ||
		afterFirst.columns.length !== EXPECTED_ADDITIVE_COLUMNS.length
	) {
		throw new Error(
			"first migration run did not apply exactly seven additive journal entries",
		);
	}
	if (
		JSON.stringify(afterFirst.columns) !==
		JSON.stringify(EXPECTED_ADDITIVE_COLUMNS)
	) {
		throw new Error(
			"first migration run did not create the expected additive columns",
		);
	}
	if (
		afterFirst.journalEntries !== afterSecond.journalEntries ||
		afterFirst.schemaFingerprint !== afterSecond.schemaFingerprint ||
		JSON.stringify(afterFirst.columns) !== JSON.stringify(afterSecond.columns)
	) {
		throw new Error("second migration run changed the journal or schema");
	}
	return { addedJournalEntries, secondRunNoOp: true };
}

export function verifyNoNewRequiredEnvironment(
	baseline: EnvironmentProbe,
	candidate: EnvironmentProbe,
): {
	baselineRequiredKeys: string[];
	candidateRequiredKeys: string[];
	newRequiredKeys: string[];
} {
	if (!baseline.accepted || !candidate.accepted) {
		throw new Error(
			`environment contract probe rejected the shared 0.6.8 input (baseline: ${(baseline.issues ?? []).join("; ") || "accepted"}; candidate: ${(candidate.issues ?? []).join("; ") || "accepted"})`,
		);
	}
	const baselineRequiredKeys = [...new Set(baseline.requiredKeys)].sort();
	const candidateRequiredKeys = [...new Set(candidate.requiredKeys)].sort();
	const baselineSet = new Set(baselineRequiredKeys);
	const newRequiredKeys = candidateRequiredKeys.filter(
		(key) => !baselineSet.has(key),
	);
	if (newRequiredKeys.length > 0) {
		throw new Error(
			`0.7 requires new environment variables: ${newRequiredKeys.join(", ")}`,
		);
	}
	return { baselineRequiredKeys, candidateRequiredKeys, newRequiredKeys };
}

export function verifyAtomicAdoption(
	evidence: AtomicAdoptionEvidence,
	expected: { candidateCommit: string; packageManifests: string[] },
): { adoptionCommit: string; version: string } {
	if (!COMMIT_PATTERN.test(evidence.adoptionCommit)) {
		throw new Error("atomic adoption commit is not a full Git SHA");
	}
	if (
		!COMMIT_PATTERN.test(expected.candidateCommit) ||
		evidence.candidateCommit !== expected.candidateCommit ||
		evidence.submoduleCommit !== expected.candidateCommit
	) {
		throw new Error(
			"atomic adoption submodule does not match the OSS candidate commit",
		);
	}
	for (const manifest of expected.packageManifests) {
		if (evidence.packageVersions[manifest] !== OSS_CANDIDATE_VERSION) {
			throw new Error(`atomic adoption did not pin ${manifest} to ${OSS_CANDIDATE_VERSION}`);
		}
		if (!evidence.commitFiles.includes(manifest)) {
			throw new Error(`atomic adoption commit is missing ${manifest}`);
		}
	}
	for (const path of [
		"bun.lock",
		"docsmint-oss",
		".docsmint-oss-adoption.json",
	]) {
		if (!evidence.commitFiles.includes(path)) {
			throw new Error(`atomic adoption commit is missing ${path}`);
		}
	}
	if (evidence.lockfileVersion !== OSS_CANDIDATE_VERSION) {
		throw new Error(`atomic adoption lockfile does not resolve ${OSS_CANDIDATE_VERSION}`);
	}
	if (!evidence.localTarballResolved) {
		throw new Error(
			"atomic adoption did not resolve the local packed OSS candidate",
		);
	}
	if (evidence.packageGitHead !== expected.candidateCommit) {
		throw new Error(
			"atomic adoption package provenance does not match the candidate",
		);
	}
	if (
		!/^[0-9a-f]{64}$/.test(evidence.tarballSha256) ||
		evidence.verifiedTarballSha256 !== evidence.tarballSha256
	) {
		throw new Error("atomic adoption tarball content hash was not preserved");
	}
	if (
		evidence.provenanceRecord.candidateCommit !== expected.candidateCommit ||
		evidence.provenanceRecord.packageGitHead !== expected.candidateCommit ||
		evidence.provenanceRecord.tarballSha256 !== evidence.tarballSha256
	) {
		throw new Error(
			"atomic adoption provenance record is not bound to the candidate",
		);
	}
	return { adoptionCommit: evidence.adoptionCommit, version: OSS_CANDIDATE_VERSION };
}

export function verifyRuntimeSmoke(
	evidence: RuntimeSmokeEvidence,
	options: { requireAssertionScope: boolean },
): { version: string; passed: true } {
	const failed = [
		...[evidence.health ? undefined : "health"],
		...[evidence.crud.create ? undefined : "create"],
		...[evidence.crud.read ? undefined : "read"],
		...[evidence.crud.update ? undefined : "update"],
		...[evidence.crud.delete ? undefined : "delete"],
		...[evidence.search ? undefined : "search"],
	].filter((value): value is string => value !== undefined);
	if (failed.length > 0) {
		throw new Error(
			`${evidence.version} runtime smoke failed: ${failed.join(", ")}`,
		);
	}
	if (
		options.requireAssertionScope &&
		(!evidence.assertionScope?.allowedDocumentVisible ||
			!evidence.assertionScope.foreignDocumentHidden)
	) {
		throw new Error(`${evidence.version} assertion scope smoke failed`);
	}
	return { version: evidence.version, passed: true };
}

export async function runRehearsalWorkflow<TPrepared extends PreparedRehearsal>(
	operations: RehearsalWorkflowOperations<TPrepared>,
	expectedAdoption: { candidateCommit: string; packageManifests: string[] },
): Promise<RehearsalWorkflowReport> {
	await operations.assertRealCheckoutClean("before");
	let prepared: TPrepared | undefined;
	try {
		prepared = await operations.prepare();
		validateTemporaryRoot(prepared.root);
		const adoption = await operations.packAndAdopt(prepared);
		verifyAtomicAdoption(adoption, expectedAdoption);
		const snapshots = await operations.migrate(prepared);
		const migration = verifyAdditiveMigrationReapply(
			snapshots.before,
			snapshots.afterFirst,
			snapshots.afterSecond,
		);
		const probes = await operations.probeEnvironment(prepared);
		const environment = verifyNoNewRequiredEnvironment(
			probes.baseline,
			probes.candidate,
		);
		const runtime070 = await operations.smoke070(prepared);
		verifyRuntimeSmoke(runtime070, { requireAssertionScope: true });
		const runtime068 = await operations.smoke068(prepared);
		verifyRuntimeSmoke(runtime068, { requireAssertionScope: false });
		return { adoption, migration, environment, runtime070, runtime068 };
	} finally {
		try {
			if (prepared) await operations.cleanup(prepared);
		} finally {
			await operations.assertRealCheckoutClean("after");
		}
	}
}

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const HOST_SOURCE_ROOT = "/mnt/data/projects/docsmint";
const OSS_REPOSITORY_ROOT = "/mnt/data/projects/docsmint-oss";
const BASELINE_HOST_COMMIT = "31485e6679608a762b6fda4a8ee8f97afbf76577";
const BASELINE_OSS_COMMIT = "ea83e5380596567434545ac2a34f65d241a9e75b";
const PACKAGE_MANIFESTS = [
	"package.json",
	"apps/api/package.json",
	"apps/web/package.json",
	"packages/cli/package.json",
	"packages/mcp/package.json",
];
const POSTGRES_ADMIN_ROLE = "aiuser";
const POSTGRES_HOST_PORT = 5437;
const STORAGE_HOST_PORT = 50702;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CommandOptions {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	allowFailure?: boolean;
}

const REGISTERED_SECRETS = new Set<string>();

class SafeCommandRunner {
	readonly secrets = REGISTERED_SECRETS;

	addSecrets(...values: string[]): void {
		for (const value of values) if (value) this.secrets.add(value);
	}

	redact(value: string): string {
		return redactSecrets(value, [...this.secrets]);
	}

	async run(
		command: string[],
		options: CommandOptions = {},
	): Promise<CommandResult> {
		const child = Bun.spawn(command, {
			...(options.cwd ? { cwd: options.cwd } : {}),
			...(options.env ? { env: options.env } : {}),
			stdin: options.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (
			options.stdin !== undefined &&
			child.stdin &&
			typeof child.stdin !== "number"
		) {
			child.stdin.write(options.stdin);
			child.stdin.end();
		}
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const result = {
			exitCode,
			stdout: this.redact(stdout),
			stderr: this.redact(stderr),
		};
		if (exitCode !== 0 && !options.allowFailure) {
			throw new Error(
				`command failed (${command.map((part) => this.redact(part)).join(" ")}):\n${result.stdout}${result.stderr}`,
			);
		}
		return result;
	}
}

export async function resolveComposeServiceContainer(
	service: string,
	environment: Record<string, string>,
): Promise<string> {
	if (service !== "postgres" && service !== "seaweedfs") {
		throw new Error("invalid rehearsal Compose service");
	}
	const project = environment.COMPOSE_PROJECT_NAME ?? "";
	if (!CONTAINER_PATTERN.test(project)) {
		throw new Error("explicit Compose project name is required for rehearsal");
	}
	const child = Bun.spawn(
		[
			"docker",
			"ps",
			"--filter",
			`label=com.docker.compose.project=${project}`,
			"--filter",
			`label=com.docker.compose.service=${service}`,
			"--format",
			"{{.ID}}",
		],
		{ env: environment, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const container = stdout.trim();
	if (exitCode !== 0 || !CONTAINER_PATTERN.test(container)) {
		throw new Error(`active Compose ${service} container is unavailable`);
	}
	return container;
}

interface ActiveRuntime {
	version: string;
	child: ReturnType<typeof Bun.spawn>;
	stdout: Promise<string>;
	stderr: Promise<string>;
}

interface ActualPreparedRehearsal extends PreparedRehearsal {
	token: string;
	candidateCommit: string;
	hostRoot: string;
	baselineRoot: string;
	candidateSourceRoot: string;
	stageRoot: string;
	tarballRoot: string;
	cacheRoot: string;
	databaseName: string;
	ownerRole: string;
	runtimeRole: string;
	ownerUrl: string;
	runtimeUrl: string;
	redisPort: number;
	redisUrl: string;
	redisServer?: IsolatedRedisServer;
	storageBucket: string;
	userId: string;
	workspaceId: string;
	categoryA: string;
	categoryB: string;
	assertionSecret: string;
	issuer: string;
	apiKey: string;
	storageAccessKey: string;
	storageSecret: string;
	betterAuthSecret: string;
	csrfSecret: string;
	webhookSecret: string;
	apiKeyEncryptionSecret: string;
	tarball?: string;
	rollbackDocumentId?: string;
	activeRuntime?: ActiveRuntime;
	embeddingServer: ReturnType<typeof Bun.serve>;
	postgresCreated: boolean;
	storageBucketCreated: boolean;
	preferredStorageBucket: string;
	preferredStorageBucketCreated: boolean;
}

function safeEnvironment(
	extra: Record<string, string> = {},
): Record<string, string> {
	const environment: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		...extra,
	};
	return environment;
}

function assertIdentifier(value: string, label: string): string {
	if (!IDENTIFIER_PATTERN.test(value)) throw new Error(`invalid ${label}`);
	return value;
}

function assertContainedPath(root: string, path: string): string {
	const validatedRoot = validateTemporaryRoot(root);
	const normalized = resolve(path);
	if (
		normalized !== validatedRoot &&
		!normalized.startsWith(`${validatedRoot}${sep}`)
	) {
		throw new Error(`temporary path escapes rehearsal root: ${path}`);
	}
	return normalized;
}

function randomHex(bytes = 24): string {
	const output = new Uint8Array(bytes);
	crypto.getRandomValues(output);
	return Array.from(output, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function connectionUrl(
	role: string,
	password: string,
	database: string,
): string {
	return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${POSTGRES_HOST_PORT}/${encodeURIComponent(database)}`;
}

export function disposableRehearsalBuckets(input: {
	preferredBucket: string;
	selectedBucket: string;
	preferredCreated: boolean;
}): string[] {
	if (!input.preferredCreated) return [];
	return [input.preferredBucket];
}

async function ensureWritableRehearsalBucket(input: {
	preferredBucket: string;
	fallbackBucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}): Promise<{
	bucket: string;
	created: boolean;
	preferredCreated: boolean;
	preferredBucket: string;
}> {
	const {
		CreateBucketCommand,
		PutObjectCommand,
		DeleteObjectCommand,
		DeleteBucketCommand,
		S3Client,
	} = await import("@aws-sdk/client-s3");
	const client = new S3Client({
		endpoint: `http://127.0.0.1:${STORAGE_HOST_PORT}`,
		region: "us-east-1",
		credentials: {
			accessKeyId: input.accessKeyId,
			secretAccessKey: input.secretAccessKey,
		},
		forcePathStyle: true,
	});
	const probe = async (bucket: string): Promise<boolean> => {
		const key = `rehearsal-probe/${crypto.randomUUID()}`;
		try {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
					ContentType: "image/png",
				}),
			);
			await client
				.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
				.catch(() => undefined);
			return true;
		} catch {
			return false;
		}
	};
	const deletePreferred = async (): Promise<boolean> => {
		try {
			await client.send(
				new DeleteBucketCommand({ Bucket: input.preferredBucket }),
			);
			return true;
		} catch (error) {
			const status =
				error && typeof error === "object" && "$metadata" in error
					? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
					: undefined;
			return status === 404;
		}
	};
	try {
		await client.send(
			new CreateBucketCommand({ Bucket: input.preferredBucket }),
		);
		if (await probe(input.preferredBucket)) {
			return {
				bucket: input.preferredBucket,
				created: true,
				preferredCreated: true,
				preferredBucket: input.preferredBucket,
			};
		}
		if (await probe(input.fallbackBucket)) {
			const removed = await deletePreferred();
			return {
				bucket: input.fallbackBucket,
				created: false,
				preferredCreated: !removed,
				preferredBucket: input.preferredBucket,
			};
		}
		await deletePreferred();
		throw new Error(
			"SeaweedFS accepted no writable rehearsal bucket for attachment PUT",
		);
	} finally {
		client.destroy();
	}
}

async function localSeaweedCredentials(
	runner: SafeCommandRunner,
): Promise<{ accessKey: string; secretKey: string }> {
	const container = await resolveComposeServiceContainer(
		"seaweedfs",
		safeEnvironment({ COMPOSE_PROJECT_NAME: Bun.env.COMPOSE_PROJECT_NAME ?? "" }),
	);
	const inspected = await runner.run(
		[
			"docker",
			"inspect",
			"--format",
			"{{json .Config.Env}}",
			container,
		],
		{ env: safeEnvironment() },
	);
	const entries = JSON.parse(inspected.stdout) as string[];
	const configured = entries.find((entry) =>
		entry.startsWith("SEAWEEDFS_S3_CONFIG="),
	);
	if (!configured)
		throw new Error("local SeaweedFS identity configuration is unavailable");
	const value = JSON.parse(configured.slice(configured.indexOf("=") + 1)) as {
		identities?: Array<{
			credentials?: Array<{ accessKey?: string; secretKey?: string }>;
		}>;
	};
	const credential = value.identities?.flatMap(
		(identity) => identity.credentials ?? [],
	)[0];
	if (!credential?.accessKey || !credential.secretKey) {
		throw new Error("local SeaweedFS identity has no usable credential");
	}
	runner.addSecrets(credential.accessKey, credential.secretKey);
	return { accessKey: credential.accessKey, secretKey: credential.secretKey };
}

async function dockerPostgres(
	runner: SafeCommandRunner,
	sql: string,
	allowFailure = false,
): Promise<CommandResult> {
	const container = await resolveComposeServiceContainer(
		"postgres",
		safeEnvironment({ COMPOSE_PROJECT_NAME: Bun.env.COMPOSE_PROJECT_NAME ?? "" }),
	);
	assertIdentifier(POSTGRES_ADMIN_ROLE, "PostgreSQL admin role");
	return runner.run(
		[
			"docker",
			"exec",
			"-i",
			container,
			"psql",
			"-X",
			"-v",
			"ON_ERROR_STOP=1",
			"-U",
			POSTGRES_ADMIN_ROLE,
			"-d",
			"postgres",
		],
		{ env: safeEnvironment(), stdin: sql, allowFailure },
	);
}

async function cloneSubmodule(
	runner: SafeCommandRunner,
	hostRoot: string,
	commit: string,
): Promise<void> {
	if (!COMMIT_PATTERN.test(commit)) throw new Error("invalid submodule commit");
	const destination = join(hostRoot, "docsmint-oss");
	await runner.run(
		[
			"git",
			"clone",
			"--local",
			"--no-hardlinks",
			OSS_REPOSITORY_ROOT,
			destination,
		],
		{ cwd: hostRoot, env: safeEnvironment() },
	);
	await runner.run(["git", "checkout", "--detach", commit], {
		cwd: destination,
		env: safeEnvironment(),
	});
}

async function collectCandidateProvenance(
	runner: SafeCommandRunner,
	root: string,
	candidateCommit: string,
): Promise<CandidateProvenanceEvidence> {
	const [headCommit, headTree, indexTree, status, submodules] =
		await Promise.all([
			runner.run(["git", "rev-parse", "HEAD"], {
				cwd: root,
				env: safeEnvironment(),
			}),
			runner.run(["git", "rev-parse", "HEAD^{tree}"], {
				cwd: root,
				env: safeEnvironment(),
			}),
			runner.run(["git", "write-tree"], {
				cwd: root,
				env: safeEnvironment(),
			}),
			runner.run(
				[
					"git",
					"status",
					"--porcelain=v1",
					"--untracked-files=all",
					"--ignore-submodules=none",
				],
				{ cwd: root, env: safeEnvironment() },
			),
			runner.run(["git", "submodule", "status", "--recursive"], {
				cwd: root,
				env: safeEnvironment(),
			}),
		]);
	return {
		candidateCommit,
		headCommit: headCommit.stdout.trim(),
		headTree: headTree.stdout.trim(),
		indexTree: indexTree.stdout.trim(),
		status: status.stdout,
		submoduleStatus: submodules.stdout.split("\n").filter(Boolean),
	};
}

function dependencyVersion(manifest: {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}): string {
	return (
		manifest.dependencies?.["@hiai-gg/docsmint"] ??
		manifest.devDependencies?.["@hiai-gg/docsmint"] ??
		""
	);
}

function resolvedHostLockVersion(lockfile: string): string {
	return (
		/"@hiai-gg\/docsmint": \["@hiai-gg\/docsmint@([^"]+)"/.exec(
			lockfile,
		)?.[1] ?? ""
	);
}

async function collectHostBaselineEvidence(
	runner: SafeCommandRunner,
	root: string,
): Promise<HostBaselineEvidence> {
	const baseCommit = (
		await runner.run(["git", "rev-parse", "HEAD"], {
			cwd: root,
			env: safeEnvironment(),
		})
	).stdout.trim();
	const packageVersions: Record<string, string> = {};
	for (const manifestPath of PACKAGE_MANIFESTS) {
		const manifest = JSON.parse(
			await readFile(join(root, manifestPath), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		packageVersions[manifestPath] = dependencyVersion(manifest);
	}
	const lockfileVersion = resolvedHostLockVersion(
		await readFile(join(root, "bun.lock"), "utf8"),
	);
	const launcher = await readFile(
		join(root, "apps/api/src/lib/oss-034-quota-launcher.ts"),
		"utf8",
	);
	const launcherVersion =
		/OSS_QUOTA_LAUNCHER_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(launcher)?.[1] ??
		"";
	const gitlinkCommit = (
		await runner.run(["git", "rev-parse", ":docsmint-oss"], {
			cwd: root,
			env: safeEnvironment(),
		})
	).stdout.trim();
	const submoduleCommit = (
		await runner.run(["git", "rev-parse", "HEAD"], {
			cwd: join(root, "docsmint-oss"),
			env: safeEnvironment(),
		})
	).stdout.trim();
	return {
		expectedCommit: BASELINE_HOST_COMMIT,
		baseCommit,
		packageVersions,
		lockfileVersion,
		launcherVersion,
		gitlinkCommit,
		submoduleCommit,
		expectedSubmoduleCommit: BASELINE_OSS_COMMIT,
	};
}

async function runUpstreamMigrations(
	runner: SafeCommandRunner,
	submoduleRoot: string,
	ownerUrl: string,
): Promise<void> {
	const source = [
		'import { runMigrations } from "./scripts/migrate.ts";',
		"const url = Bun.env.REHEARSAL_DATABASE_URL;",
		'if (!url) throw new Error("REHEARSAL_DATABASE_URL is required");',
		"await runMigrations(url);",
	].join("\n");
	await runner.run(["bun", "-e", source], {
		cwd: join(submoduleRoot, "packages/db"),
		env: safeEnvironment({ REHEARSAL_DATABASE_URL: ownerUrl }),
	});
}

async function runBaselineHostMigrations(
	runner: SafeCommandRunner,
	baselineRoot: string,
	ownerUrl: string,
): Promise<void> {
	const environment = safeEnvironment({ MIGRATION_DATABASE_URL: ownerUrl });
	await runner.run(
		["bun", "run", "packages/db/scripts/ensure-product-schema.ts"],
		{
			cwd: baselineRoot,
			env: environment,
		},
	);
	await runner.run(["bun", "run", "packages/db/scripts/migrate-overlay.ts"], {
		cwd: baselineRoot,
		env: environment,
	});
}

async function prepareActualRehearsal(
	runner: SafeCommandRunner,
	candidateCommit: string,
): Promise<ActualPreparedRehearsal> {
	const storageCredential = await localSeaweedCredentials(runner);
	const root = validateTemporaryRoot(
		`/tmp/docsmint-host-adoption-${randomHex(12)}`,
	);
	await mkdir(root);
	const token = basename(root).slice("docsmint-host-adoption-".length);
	if (!/^[0-9A-Za-z]{6,64}$/.test(token)) {
		await rm(root, { recursive: true, force: true });
		throw new Error("temporary root did not contain a unique token");
	}
	const normalizedToken = new Bun.CryptoHasher("sha256")
		.update(token)
		.digest("hex")
		.slice(0, 12);
	const databaseName = assertIdentifier(
		`dm_rehearsal_${normalizedToken}`,
		"database name",
	);
	const ownerRole = assertIdentifier(
		`dm_owner_${normalizedToken}`,
		"owner role",
	);
	const runtimeRole = assertIdentifier(
		`dm_runtime_${normalizedToken}`,
		"runtime role",
	);
	const ownerPassword = randomHex();
	const runtimePassword = randomHex();
	const assertionSecret = randomHex(32);
	const apiKey = randomHex(32);
	const storageSecret = storageCredential.secretKey;
	const betterAuthSecret = randomHex(32);
	const csrfSecret = randomHex(32);
	const webhookSecret = randomHex(32);
	const apiKeyEncryptionSecret = randomHex(32);
	runner.addSecrets(
		ownerPassword,
		runtimePassword,
		assertionSecret,
		apiKey,
		storageCredential.accessKey,
		storageSecret,
		betterAuthSecret,
		csrfSecret,
		webhookSecret,
		apiKeyEncryptionSecret,
	);
	const embeddingServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname !== "/v1/embeddings") {
				return new Response("Not found", { status: 404 });
			}
			const embedding = Array.from({ length: 1024 }, (_, index) =>
				index === 0 ? 1 : 0,
			);
			return Response.json({ data: [{ embedding }], model: "rehearsal-1024" });
		},
	});
	const prepared: ActualPreparedRehearsal = {
		root,
		token: normalizedToken,
		candidateCommit,
		hostRoot: assertContainedPath(root, join(root, "host-070")),
		baselineRoot: assertContainedPath(root, join(root, "host-068")),
		candidateSourceRoot: assertContainedPath(root, join(root, "oss-candidate")),
		stageRoot: assertContainedPath(root, join(root, "candidate-stage")),
		tarballRoot: assertContainedPath(root, join(root, "tarballs")),
		cacheRoot: assertContainedPath(root, join(root, "bun-cache")),
		databaseName,
		ownerRole,
		runtimeRole,
		ownerUrl: connectionUrl(ownerRole, ownerPassword, databaseName),
		runtimeUrl: connectionUrl(runtimeRole, runtimePassword, databaseName),
		redisPort: -1,
		redisUrl: "",
		storageBucket: "",
		userId: crypto.randomUUID(),
		workspaceId: crypto.randomUUID(),
		categoryA: crypto.randomUUID(),
		categoryB: crypto.randomUUID(),
		assertionSecret,
		issuer: `dm-rehearsal-${normalizedToken}`,
		apiKey,
		storageAccessKey: storageCredential.accessKey,
		storageSecret,
		betterAuthSecret,
		csrfSecret,
		webhookSecret,
		apiKeyEncryptionSecret,
		embeddingServer,
		postgresCreated: false,
		storageBucketCreated: false,
		preferredStorageBucket: "",
		preferredStorageBucketCreated: false,
	};
	runner.addSecrets(prepared.ownerUrl, prepared.runtimeUrl);
	try {
		prepared.redisServer = await startIsolatedRedisServer(root);
		prepared.redisPort = prepared.redisServer.port;
		prepared.redisUrl = prepared.redisServer.url;
		await mkdir(prepared.cacheRoot, { recursive: true });
		await runner.run(
			[
				"git",
				"clone",
				"--local",
				"--no-hardlinks",
				HOST_SOURCE_ROOT,
				prepared.hostRoot,
			],
			{ cwd: root, env: safeEnvironment() },
		);
		await runner.run(["git", "checkout", "--detach", BASELINE_HOST_COMMIT], {
			cwd: prepared.hostRoot,
			env: safeEnvironment(),
		});
		await runner.run(
			[
				"git",
				"worktree",
				"add",
				"--detach",
				prepared.baselineRoot,
				BASELINE_HOST_COMMIT,
			],
			{ cwd: prepared.hostRoot, env: safeEnvironment() },
		);
		await cloneSubmodule(runner, prepared.hostRoot, BASELINE_OSS_COMMIT);
		await cloneSubmodule(runner, prepared.baselineRoot, BASELINE_OSS_COMMIT);
		verifyHostBaseline(
			await collectHostBaselineEvidence(runner, prepared.hostRoot),
		);
		verifyHostBaseline(
			await collectHostBaselineEvidence(runner, prepared.baselineRoot),
		);
		await runner.run(
			["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
			{
				cwd: prepared.baselineRoot,
				env: safeEnvironment({
					BUN_INSTALL_CACHE_DIR: prepared.cacheRoot,
					TMPDIR: root,
				}),
			},
		);
		const installedBaseline = JSON.parse(
			await readFile(
				join(
					prepared.baselineRoot,
					"node_modules/@hiai-gg/docsmint/package.json",
				),
				"utf8",
			),
		) as { version?: string };
		if (installedBaseline.version !== "0.6.8") {
			throw new Error("exact host 0.6.8 baseline install verification failed");
		}
		await runner.run(
			["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
			{
				cwd: join(prepared.baselineRoot, "docsmint-oss"),
				env: safeEnvironment({
					BUN_INSTALL_CACHE_DIR: prepared.cacheRoot,
					TMPDIR: root,
				}),
			},
		);
		prepared.postgresCreated = true;
		await dockerPostgres(
			runner,
			[
				`CREATE ROLE ${ownerRole} WITH LOGIN SUPERUSER PASSWORD '${ownerPassword}';`,
				`CREATE ROLE ${runtimeRole} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '${runtimePassword}';`,
				`CREATE DATABASE ${databaseName} OWNER ${ownerRole};`,
			].join("\n"),
		);
		const bootstrap = postgres(prepared.ownerUrl, { max: 1 });
		try {
			await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS age CASCADE");
		} finally {
			await bootstrap.end();
		}
		const writable = await ensureWritableRehearsalBucket({
			preferredBucket: `dm-rehearsal-${normalizedToken}`,
			fallbackBucket: Bun.env.STORAGE_BUCKET?.trim() || "hiai-docs",
			accessKeyId: prepared.storageAccessKey,
			secretAccessKey: prepared.storageSecret,
		});
		prepared.storageBucket = writable.bucket;
		prepared.storageBucketCreated = writable.created;
		prepared.preferredStorageBucket = writable.preferredBucket;
		prepared.preferredStorageBucketCreated = writable.preferredCreated;
		await runUpstreamMigrations(
			runner,
			join(prepared.baselineRoot, "docsmint-oss"),
			prepared.ownerUrl,
		);
		await runBaselineHostMigrations(
			runner,
			prepared.baselineRoot,
			prepared.ownerUrl,
		);
		const owner = postgres(prepared.ownerUrl, { max: 1 });
		try {
			await owner.unsafe(`GRANT hiai_app TO ${runtimeRole}`);
			await owner`
				INSERT INTO public.users (id, email, name)
				VALUES (${prepared.userId}::uuid, ${`${normalizedToken}@rehearsal.invalid`}, 'Rehearsal User')`;
			await owner`
				INSERT INTO public.workspaces
					(id, slug, name, kind, created_by_user_id, billing_owner_user_id, required_tier)
				VALUES
					(${prepared.workspaceId}::uuid, ${`rehearsal-${normalizedToken}`},
					 'Rehearsal workspace', 'shared', ${prepared.userId}::uuid,
					 ${prepared.userId}::uuid, 1)`;
			await owner`
				INSERT INTO public.workspace_members
					(workspace_id, user_id, role, status, created_by_user_id)
				VALUES
					(${prepared.workspaceId}::uuid, ${prepared.userId}::uuid,
					 'owner', 'active', ${prepared.userId}::uuid)`;
			await owner`
				INSERT INTO public.categories (id, owner_id, workspace_id, name)
				VALUES
					(${prepared.categoryA}::uuid, ${prepared.userId}::uuid, ${prepared.workspaceId}, 'Rehearsal A'),
					(${prepared.categoryB}::uuid, ${prepared.userId}::uuid, ${prepared.workspaceId}, 'Rehearsal B')`;
		} finally {
			await owner.end();
		}
		return prepared;
	} catch (error) {
		await cleanupActualRehearsal(runner, prepared).catch(() => undefined);
		throw error;
	}
}

async function stopRuntime(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<void> {
	const runtime = prepared.activeRuntime;
	if (!runtime) return;
	prepared.activeRuntime = undefined;
	runtime.child.kill("SIGTERM");
	const exited = await Promise.race([
		runtime.child.exited.then(() => true),
		Bun.sleep(5_000).then(() => false),
	]);
	if (!exited) runtime.child.kill("SIGKILL");
	await runtime.child.exited;
	const [stdout, stderr] = await Promise.all([runtime.stdout, runtime.stderr]);
	if (stderr.includes("[REDACTED]") || stdout.includes("[REDACTED]")) {
		throw new Error(`${runtime.version} runtime emitted a registered secret`);
	}
	runner.redact(stdout);
	runner.redact(stderr);
}

async function cleanupActualRehearsal(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<void> {
	const failures: string[] = [];
	try {
		await stopRuntime(runner, prepared);
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}
	try {
		prepared.embeddingServer.stop(true);
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}
	const bucketsToDelete = disposableRehearsalBuckets({
		preferredBucket: prepared.preferredStorageBucket,
		selectedBucket: prepared.storageBucket,
		preferredCreated: prepared.preferredStorageBucketCreated,
	});
	if (prepared.storageBucketCreated && prepared.storageBucket) {
		if (!bucketsToDelete.includes(prepared.storageBucket)) {
			bucketsToDelete.push(prepared.storageBucket);
		}
	}
	if (bucketsToDelete.length > 0) {
		try {
			const { DeleteBucketCommand, S3Client } = await import(
				"@aws-sdk/client-s3"
			);
			const storageClient = new S3Client({
				endpoint: `http://127.0.0.1:${STORAGE_HOST_PORT}`,
				region: "us-east-1",
				credentials: {
					accessKeyId: prepared.storageAccessKey,
					secretAccessKey: prepared.storageSecret,
				},
				forcePathStyle: true,
			});
			try {
				for (const bucket of bucketsToDelete) {
					try {
						await storageClient.send(
							new DeleteBucketCommand({ Bucket: bucket }),
						);
					} catch (error) {
						const status =
							error && typeof error === "object" && "$metadata" in error
								? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
								: undefined;
						if (status !== 404) throw error;
					}
				}
			} finally {
				storageClient.destroy();
			}
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (prepared.redisServer) {
		try {
			await stopIsolatedRedisServer(prepared.redisServer);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (prepared.postgresCreated) {
		try {
			assertIdentifier(prepared.databaseName, "cleanup database name");
			assertIdentifier(prepared.runtimeRole, "cleanup runtime role");
			assertIdentifier(prepared.ownerRole, "cleanup owner role");
			await dockerPostgres(
				runner,
				[
					`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${prepared.databaseName}' AND pid <> pg_backend_pid();`,
					`DROP DATABASE IF EXISTS ${prepared.databaseName};`,
					`DROP ROLE IF EXISTS ${prepared.runtimeRole};`,
					`DROP ROLE IF EXISTS ${prepared.ownerRole};`,
				].join("\n"),
			);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	try {
		const root = validateTemporaryRoot(prepared.root);
		await rm(root, { recursive: true, force: true });
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}
	if (failures.length > 0) {
		throw new Error(
			`rehearsal cleanup failed: ${runner.redact(failures.join("; "))}`,
		);
	}
}

async function stageCandidateTarball(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<{ tarball: string; sha256: string }> {
	await runner.run(
		[
			"git",
			"clone",
			"--local",
			"--no-hardlinks",
			OSS_REPOSITORY_ROOT,
			prepared.candidateSourceRoot,
		],
		{ cwd: prepared.root, env: safeEnvironment() },
	);
	await runner.run(["git", "checkout", "--detach", prepared.candidateCommit], {
		cwd: prepared.candidateSourceRoot,
		env: safeEnvironment(),
	});
	verifyCandidateProvenance(
		await collectCandidateProvenance(
			runner,
			prepared.candidateSourceRoot,
			prepared.candidateCommit,
		),
	);
	await runner.run(
		["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
		{
			cwd: prepared.candidateSourceRoot,
			env: safeEnvironment({
				BUN_INSTALL_CACHE_DIR: prepared.cacheRoot,
				TMPDIR: prepared.root,
			}),
		},
	);
	await runner.run(["bun", "run", "build:sdk"], {
		cwd: prepared.candidateSourceRoot,
		env: safeEnvironment({ TMPDIR: prepared.root }),
	});
	verifyCandidateProvenance(
		await collectCandidateProvenance(
			runner,
			prepared.candidateSourceRoot,
			prepared.candidateCommit,
		),
	);
	const publicManifest = JSON.parse(
		await readFile(
			join(prepared.candidateSourceRoot, "package.public.json"),
			"utf8",
		),
	) as { name: string; version: string; files: string[]; gitHead?: string };
	if (
		publicManifest.name !== "@hiai-gg/docsmint" ||
		publicManifest.version !== OSS_CANDIDATE_VERSION ||
		!Array.isArray(publicManifest.files)
	) {
		throw new Error(`candidate public manifest is not @hiai-gg/docsmint@${OSS_CANDIDATE_VERSION}`);
	}
	publicManifest.gitHead = prepared.candidateCommit;
	await mkdir(prepared.stageRoot, { recursive: true });
	await mkdir(prepared.tarballRoot, { recursive: true });
	await writeFile(
		join(prepared.stageRoot, "package.json"),
		`${JSON.stringify(publicManifest, null, 2)}\n`,
	);
	for (const entry of publicManifest.files) {
		if (!entry || isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
			throw new Error(`unsafe public package file entry: ${entry}`);
		}
		const source =
			entry === "dist"
				? join(prepared.candidateSourceRoot, "packages/sdk/dist")
				: join(prepared.candidateSourceRoot, entry);
		await cp(source, join(prepared.stageRoot, entry), { recursive: true });
	}
	const pack = await runner.run(
		[
			"bun",
			"pm",
			"pack",
			"--ignore-scripts",
			"--destination",
			prepared.tarballRoot,
			"--quiet",
		],
		{
			cwd: prepared.stageRoot,
			env: safeEnvironment({ TMPDIR: prepared.root }),
		},
	);
	const outputPath = pack.stdout.trim().split("\n").at(-1);
	if (!outputPath) throw new Error("candidate pack did not report a tarball");
	const tarball = assertContainedPath(
		prepared.root,
		isAbsolute(outputPath) ? outputPath : join(prepared.stageRoot, outputPath),
	);
	const canonicalTarball = await realpath(tarball);
	assertContainedPath(prepared.root, canonicalTarball);
	prepared.tarball = canonicalTarball;
	const sha256 = new Bun.CryptoHasher("sha256")
		.update(await readFile(canonicalTarball))
		.digest("hex");
	return { tarball: canonicalTarball, sha256 };
}

async function updatePackageVersion(path: string): Promise<void> {
	const manifest = JSON.parse(await readFile(path, "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		overrides?: Record<string, string>;
	};
	const field = manifest.dependencies?.["@hiai-gg/docsmint"]
		? "dependencies"
		: manifest.devDependencies?.["@hiai-gg/docsmint"]
			? "devDependencies"
			: undefined;
	if (!field) throw new Error(`${path} has no @hiai-gg/docsmint dependency`);
	(manifest[field] as Record<string, string>)["@hiai-gg/docsmint"] = OSS_CANDIDATE_VERSION;
	await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function packAndAdoptActual(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<AtomicAdoptionEvidence> {
	const { tarball, sha256: tarballSha256 } = await stageCandidateTarball(
		runner,
		prepared,
	);
	for (const manifest of PACKAGE_MANIFESTS) {
		await updatePackageVersion(join(prepared.hostRoot, manifest));
	}
	const rootManifestPath = join(prepared.hostRoot, "package.json");
	const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8")) as {
		overrides?: Record<string, string>;
	};
	rootManifest.overrides = {
		...rootManifest.overrides,
		"@hiai-gg/docsmint": `file:${tarball}`,
	};
	await writeFile(
		rootManifestPath,
		`${JSON.stringify(rootManifest, null, 2)}\n`,
	);
	const quotaPath = join(
		prepared.hostRoot,
		"apps/api/src/lib/oss-034-quota-launcher.ts",
	);
	const oldQuota = await readFile(quotaPath, "utf8");
	if (!oldQuota.includes("0.6.8")) {
		throw new Error(
			"disposable quota launcher is not pinned to baseline 0.6.8",
		);
	}
	await writeFile(quotaPath, oldQuota.replaceAll("0.6.8", "0.7.0"));
	const provenanceRecord = {
		candidateCommit: prepared.candidateCommit,
		packageGitHead: prepared.candidateCommit,
		tarballSha256,
	};
	await writeFile(
		join(prepared.hostRoot, ".docsmint-oss-adoption.json"),
		`${JSON.stringify(provenanceRecord, null, 2)}\n`,
	);
	await runner.run(["git", "checkout", "--detach", prepared.candidateCommit], {
		cwd: join(prepared.hostRoot, "docsmint-oss"),
		env: safeEnvironment(),
	});
	await runner.run(
		["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
		{
			cwd: join(prepared.hostRoot, "docsmint-oss"),
			env: safeEnvironment({
				BUN_INSTALL_CACHE_DIR: prepared.cacheRoot,
				TMPDIR: prepared.root,
			}),
		},
	);
	await runner.run(["bun", "install", "--ignore-scripts"], {
		cwd: prepared.hostRoot,
		env: safeEnvironment({
			BUN_INSTALL_CACHE_DIR: prepared.cacheRoot,
			TMPDIR: prepared.root,
		}),
	});
	const status = await runner.run(
		["git", "status", "--porcelain=v1", "--untracked-files=all"],
		{ cwd: prepared.hostRoot, env: safeEnvironment() },
	);
	const changed = status.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(3));
	const expectedChanges = new Set([
		...PACKAGE_MANIFESTS,
		"bun.lock",
		"docsmint-oss",
		".docsmint-oss-adoption.json",
		"apps/api/src/lib/oss-034-quota-launcher.ts",
	]);
	const unexpected = changed.filter((path) => !expectedChanges.has(path));
	if (unexpected.length > 0) {
		throw new Error(
			`disposable adoption changed unexpected files: ${unexpected.join(", ")}`,
		);
	}
	for (const required of expectedChanges) {
		if (!changed.includes(required)) {
			throw new Error(`disposable adoption did not change ${required}`);
		}
	}
	const installedManifest = JSON.parse(
		await readFile(
			join(prepared.hostRoot, "node_modules/@hiai-gg/docsmint/package.json"),
			"utf8",
		),
	) as { version?: string; gitHead?: string };
	const lockfile = await readFile(join(prepared.hostRoot, "bun.lock"), "utf8");
	const localTarballResolved =
		installedManifest.version === OSS_CANDIDATE_VERSION &&
		lockfile.includes(basename(tarball));
	const verifiedTarballSha256 = new Bun.CryptoHasher("sha256")
		.update(await readFile(tarball))
		.digest("hex");
	await runner.run(["git", "add", "--", ...expectedChanges], {
		cwd: prepared.hostRoot,
		env: safeEnvironment(),
	});
	await runner.run(
		[
			"git",
			"-c",
			"user.name=DocsMint Rehearsal",
			"-c",
			"user.email=rehearsal@invalid",
			"commit",
			"-m",
			"test: adopt local OSS candidate for rehearsal",
		],
		{ cwd: prepared.hostRoot, env: safeEnvironment() },
	);
	const adoptionCommit = (
		await runner.run(["git", "rev-parse", "HEAD"], {
			cwd: prepared.hostRoot,
			env: safeEnvironment(),
		})
	).stdout.trim();
	const submoduleCommit = (
		await runner.run(["git", "rev-parse", "HEAD"], {
			cwd: join(prepared.hostRoot, "docsmint-oss"),
			env: safeEnvironment(),
		})
	).stdout.trim();
	const commitFiles = (
		await runner.run(
			["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
			{ cwd: prepared.hostRoot, env: safeEnvironment() },
		)
	).stdout
		.trim()
		.split("\n")
		.filter(Boolean);
	const packageVersions: Record<string, string> = {};
	for (const manifest of PACKAGE_MANIFESTS) {
		const value = JSON.parse(
			await readFile(join(prepared.hostRoot, manifest), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		packageVersions[manifest] =
			value.dependencies?.["@hiai-gg/docsmint"] ??
			value.devDependencies?.["@hiai-gg/docsmint"] ??
			"";
	}
	return {
		adoptionCommit,
		candidateCommit: prepared.candidateCommit,
		packageVersions,
		lockfileVersion: installedManifest.version ?? "",
		localTarballResolved,
		packageGitHead: installedManifest.gitHead ?? "",
		tarballSha256,
		verifiedTarballSha256,
		provenanceRecord,
		submoduleCommit,
		commitFiles,
	};
}

async function databaseSnapshot(ownerUrl: string): Promise<MigrationSnapshot> {
	const client = postgres(ownerUrl, { max: 1 });
	try {
		const [journal] = await client<[{ count: string }]>`
			SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
		`;
		const columns = await client<
			Array<{
				table_name: string;
				column_name: string;
				data_type: string;
				is_nullable: string;
				column_default: string | null;
			}>
		>`
			SELECT table_name, column_name, data_type, is_nullable, column_default
			FROM information_schema.columns
			WHERE table_schema = 'public'
				AND (
					(table_name = 'attachments' AND column_name = 'uploaded_by')
					OR table_name = 'pending_attachment_uploads'
					OR table_name = 'attachment_storage_cleanup_outbox'
					OR
					(table_name = 'documents' AND column_name = 'embedding_context_hash')
					OR (
						table_name = 'document_pipeline_runs'
						AND column_name IN ('embedding_context_hash', 'refresh_mode')
					)
					OR table_name = 'metadata_reembed_outbox'
				)
			ORDER BY table_name, column_name
		`;
		const normalized = columns.map(
			(column) =>
				`${column.table_name}.${column.column_name}:${column.data_type}:${column.is_nullable}:${column.column_default ?? ""}`,
		);
		const schemaFingerprint = new Bun.CryptoHasher("sha256")
			.update(JSON.stringify(normalized))
			.digest("hex");
		return {
			journalEntries: Number.parseInt(journal?.count ?? "0", 10),
			schemaFingerprint,
			columns: normalized,
		};
	} finally {
		await client.end();
	}
}

async function migrateActual(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<{
	before: MigrationSnapshot;
	afterFirst: MigrationSnapshot;
	afterSecond: MigrationSnapshot;
}> {
	const peerActorId = crypto.randomUUID();
	const workspaceDocumentId = crypto.randomUUID();
	const workspaceAttachmentId = crypto.randomUUID();
	const personalDocumentId = crypto.randomUUID();
	const personalAttachmentId = crypto.randomUUID();
	const fixture = postgres(prepared.ownerUrl, { max: 1 });
	try {
		await fixture`INSERT INTO public.users (id, email)
			VALUES (${peerActorId}::uuid, ${`${peerActorId}@migration-rehearsal.invalid`})`;
		await fixture`INSERT INTO public.documents
			(id, owner_id, workspace_id, title, content)
		VALUES
			(${workspaceDocumentId}::uuid, ${prepared.userId}::uuid,
			 ${prepared.workspaceId}, 'Historical peer attachment', ''),
			(${personalDocumentId}::uuid, ${prepared.userId}::uuid,
			 NULL, 'Historical personal attachment', '')`;
		await fixture`INSERT INTO public.attachments
			(id, document_id, workspace_id, filename, mime_type, size, storage_key)
		VALUES
			(${workspaceAttachmentId}::uuid, ${workspaceDocumentId}::uuid,
			 ${prepared.workspaceId}, 'peer.png', 'image/png', 8,
			 ${`${prepared.workspaceId}/${peerActorId}/${workspaceDocumentId}/peer.png`}),
			(${personalAttachmentId}::uuid, ${personalDocumentId}::uuid,
			 NULL, 'legacy.png', 'image/png', 8,
			 ${`noncanonical/${personalDocumentId}/legacy.png`})`;
	} finally {
		await fixture.end();
	}
	const before = await databaseSnapshot(prepared.ownerUrl);
	const submoduleRoot = join(prepared.hostRoot, "docsmint-oss");
	await runUpstreamMigrations(runner, submoduleRoot, prepared.ownerUrl);
	const afterFirst = await databaseSnapshot(prepared.ownerUrl);
	await runUpstreamMigrations(runner, submoduleRoot, prepared.ownerUrl);
	const afterSecond = await databaseSnapshot(prepared.ownerUrl);
	const verification = postgres(prepared.ownerUrl, { max: 1 });
	try {
		const rows = await verification<
			Array<{ id: string; uploaded_by: string }>
		>`SELECT id::text, uploaded_by::text
			FROM public.attachments
			WHERE id IN (${workspaceAttachmentId}::uuid, ${personalAttachmentId}::uuid)
			ORDER BY id`;
		const actors = new Map(rows.map((row) => [row.id, row.uploaded_by]));
		if (actors.get(workspaceAttachmentId) !== peerActorId) {
			throw new Error("canonical historical workspace attachment actor was not preserved");
		}
		if (actors.get(personalAttachmentId) !== prepared.userId) {
			throw new Error("noncanonical historical attachment did not fall back to its parent owner");
		}
		const liveWorkspaceAttachmentId = crypto.randomUUID();
		await verification.begin(async (tx) => {
			await tx`SELECT set_config('app.current_user_id', ${peerActorId}, true)`;
			await tx`SELECT set_config('app.current_user_role', 'user', true)`;
			await tx`SELECT set_config('app.current_workspace_id', ${prepared.workspaceId}, true)`;
			await tx`INSERT INTO public.attachments
				(id, document_id, workspace_id, filename, mime_type, size, storage_key)
				VALUES (
					${liveWorkspaceAttachmentId}::uuid, ${workspaceDocumentId}::uuid,
					${prepared.workspaceId}, 'live-peer.png', 'image/png', 4,
					${`${prepared.workspaceId}/${peerActorId}/${workspaceDocumentId}/live-peer.png`}
				)`;
		});
		const [liveActor] = await verification<Array<{ uploaded_by: string }>>`
			SELECT uploaded_by::text FROM public.attachments
			WHERE id = ${liveWorkspaceAttachmentId}::uuid`;
		if (liveActor?.uploaded_by !== peerActorId) {
			throw new Error(
				"workspace legacy insert did not inherit the current request actor",
			);
		}
	} finally {
		await verification.end();
	}
	return { before, afterFirst, afterSecond };
}

const ENVIRONMENT_PROBE_SOURCE = [
	'import { envSchema } from "./backend/src/lib/config-schema.ts";',
	"const raw = Bun.env.REHEARSAL_ENV_INPUT;",
	'if (!raw) throw new Error("REHEARSAL_ENV_INPUT is required");',
	"const input = JSON.parse(raw);",
	"const parsed = envSchema.safeParse(input);",
	'const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message);',
	"const requiredKeys = [];",
	"for (const key of Object.keys(input).sort()) {",
	"  const candidate = { ...input };",
	"  delete candidate[key];",
	"  if (!envSchema.safeParse(candidate).success) requiredKeys.push(key);",
	"}",
	"console.log(JSON.stringify({ accepted: parsed.success, requiredKeys, issues }));",
].join("\n");

function sharedEnvironmentInput(
	prepared: ActualPreparedRehearsal,
): Record<string, string> {
	return {
		NODE_ENV: "production",
		DATABASE_URL: prepared.runtimeUrl,
		REDIS_URL: prepared.redisUrl,
		AI_PROVIDER: "ollama",
		EMBEDDING_BASE_URL: `http://127.0.0.1:${prepared.embeddingServer.port}/v1`,
		EMBEDDING_MODEL: "rehearsal-1024",
		STORAGE_ENDPOINT: "127.0.0.1",
		STORAGE_PORT: String(STORAGE_HOST_PORT),
		STORAGE_PUBLIC_ENDPOINT: "127.0.0.1",
		STORAGE_PUBLIC_PORT: String(STORAGE_HOST_PORT),
		STORAGE_ACCESS_KEY: prepared.storageAccessKey,
		STORAGE_SECRET_KEY: prepared.storageSecret,
		STORAGE_BUCKET: prepared.storageBucket,
		STORAGE_FORCE_PATH_STYLE: "true",
		STORAGE_PUBLIC_ENDPOINT_URL: "https://storage.rehearsal.invalid",
		BETTER_AUTH_SECRET: prepared.betterAuthSecret,
		CSRF_SECRET: prepared.csrfSecret,
		WEBHOOK_SECRET: prepared.webhookSecret,
		HIAI_DOCS_API_KEY: prepared.apiKey,
		API_KEY_ENCRYPTION_SECRET: prepared.apiKeyEncryptionSecret,
		DOCSMINT_WORKSPACE_ENABLED: "true",
		DOCSMINT_WORKSPACE_ISSUER: prepared.issuer,
		DOCSMINT_WORKSPACE_SECRET: prepared.assertionSecret,
		GRAPH_EXTRACT_ENABLED: "false",
		GRAPH_SEARCH_ENABLED: "false",
		SEARCH_EXPANSION_ENABLED: "false",
	};
}

async function runEnvironmentProbe(
	runner: SafeCommandRunner,
	root: string,
	input: Record<string, string>,
): Promise<EnvironmentProbe> {
	const result = await runner.run(["bun", "-e", ENVIRONMENT_PROBE_SOURCE], {
		cwd: root,
		env: safeEnvironment({
			NODE_ENV: "production",
			REHEARSAL_ENV_INPUT: JSON.stringify(input),
		}),
	});
	const probe = JSON.parse(result.stdout.trim()) as EnvironmentProbe;
	if (
		typeof probe.accepted !== "boolean" ||
		!Array.isArray(probe.requiredKeys) ||
		probe.requiredKeys.some((value) => typeof value !== "string")
	) {
		throw new Error("environment probe produced malformed evidence");
	}
	return probe;
}

async function probeEnvironmentActual(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<{ baseline: EnvironmentProbe; candidate: EnvironmentProbe }> {
	const input = sharedEnvironmentInput(prepared);
	const [baseline, candidate] = await Promise.all([
		runEnvironmentProbe(
			runner,
			join(prepared.baselineRoot, "docsmint-oss"),
			input,
		),
		runEnvironmentProbe(runner, join(prepared.hostRoot, "docsmint-oss"), input),
	]);
	return { baseline, candidate };
}

async function freePort(): Promise<number> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = server.port;
	server.stop(true);
	if (!port) throw new Error("failed to reserve a local runtime port");
	return port;
}

export async function startIsolatedRedisServer(
	root: string,
): Promise<IsolatedRedisServer> {
	const validatedRoot = validateTemporaryRoot(root);
	const port = await freePort();
	const child = Bun.spawn(
		[
			"redis-server",
			"--bind",
			"127.0.0.1",
			"--port",
			String(port),
			"--save",
			"",
			"--appendonly",
			"no",
			"--dir",
			validatedRoot,
			"--dbfilename",
			`redis-${basename(validatedRoot)}.rdb`,
		],
		{
			env: safeEnvironment(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const server: IsolatedRedisServer = {
		root: validatedRoot,
		url: `redis://127.0.0.1:${port}/0`,
		port,
		child,
		stdout: new Response(child.stdout).text(),
		stderr: new Response(child.stderr).text(),
		stopped: false,
	};
	for (let attempt = 0; attempt < 80; attempt += 1) {
		const ping = Bun.spawn(["redis-cli", "-u", server.url, "PING"], {
			env: safeEnvironment(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout] = await Promise.all([
			ping.exited,
			new Response(ping.stdout).text(),
		]);
		if (exitCode === 0 && stdout.trim() === "PONG") return server;
		const exited = await Promise.race([
			child.exited.then(() => true),
			Bun.sleep(0).then(() => false),
		]);
		if (exited) break;
		await Bun.sleep(25);
	}
	await stopIsolatedRedisServer(server);
	throw new Error("isolated Redis server did not become ready");
}

export async function stopIsolatedRedisServer(
	server: IsolatedRedisServer,
): Promise<void> {
	validateTemporaryRoot(server.root);
	const parsed = new URL(server.url);
	if (
		parsed.protocol !== "redis:" ||
		parsed.hostname !== "127.0.0.1" ||
		Number(parsed.port) !== server.port
	) {
		throw new Error("isolated Redis server identity is invalid");
	}
	if (server.stopped) return;
	server.stopped = true;
	server.child.kill("SIGTERM");
	const exited = await Promise.race([
		server.child.exited.then(() => true),
		Bun.sleep(5_000).then(() => false),
	]);
	if (!exited) server.child.kill("SIGKILL");
	await server.child.exited;
	await Promise.all([server.stdout, server.stderr]);
}

export function workspaceEnabledForRuntimeVersion(version: string): "true" | "false" {
	if (version !== "0.6.8" && !/^0\.7\.\d+$/.test(version)) {
		throw new Error(`unsupported rehearsal runtime version: ${version}`);
	}
	return "true";
}

export function attachmentStorageEnforcementForRuntimeVersion(
	version: string,
): "true" | "false" {
	if (version !== "0.6.8" && !/^0\.7\.\d+$/.test(version)) {
		throw new Error(`unsupported rehearsal runtime version: ${version}`);
	}
	return "true";
}

function runtimeEnvironment(
	prepared: ActualPreparedRehearsal,
	port: number,
	version: string,
	options: Readonly<{
		workspaceEnabled?: "true" | "false";
		attachmentStorageEnforcement?: "true" | "false";
	}> = {},
): Record<string, string> {
	const workspaceEnabled =
		options.workspaceEnabled ?? workspaceEnabledForRuntimeVersion(version);
	return safeEnvironment({
		NODE_ENV: "test",
		LOG_LEVEL: "error",
		API_PORT: String(port),
		DATABASE_URL: prepared.runtimeUrl,
		REDIS_URL: prepared.redisUrl,
		AI_PROVIDER: "ollama",
		EMBEDDING_BASE_URL: `http://127.0.0.1:${prepared.embeddingServer.port}/v1`,
		EMBEDDING_MODEL: "rehearsal-1024",
		EMBEDDING_API_KEY: "rehearsal-local-provider",
		STORAGE_ENDPOINT: "127.0.0.1",
		STORAGE_PORT: String(STORAGE_HOST_PORT),
		STORAGE_PUBLIC_ENDPOINT: "127.0.0.1",
		STORAGE_PUBLIC_PORT: String(STORAGE_HOST_PORT),
		STORAGE_ACCESS_KEY: prepared.storageAccessKey,
		STORAGE_SECRET_KEY: prepared.storageSecret,
		STORAGE_BUCKET: prepared.storageBucket,
		STORAGE_FORCE_PATH_STYLE: "true",
		STORAGE_PUBLIC_ENDPOINT_URL: `http://127.0.0.1:${STORAGE_HOST_PORT}`,
		BETTER_AUTH_SECRET: prepared.betterAuthSecret,
		CSRF_SECRET: prepared.csrfSecret,
		WEBHOOK_SECRET: prepared.webhookSecret,
		HIAI_DOCS_API_KEY: prepared.apiKey,
		API_KEY_ENCRYPTION_SECRET: prepared.apiKeyEncryptionSecret,
		OWNER_ID: prepared.userId,
		DOCSMINT_WORKSPACE_ENABLED: workspaceEnabled,
		DOCSMINT_WORKSPACE_ISSUER: prepared.issuer,
		DOCSMINT_WORKSPACE_SECRET: prepared.assertionSecret,
		DOCSMINT_ATTACHMENT_STORAGE_ENFORCEMENT_ENABLED:
			workspaceEnabled === "false"
				? "false"
				: (options.attachmentStorageEnforcement ??
					attachmentStorageEnforcementForRuntimeVersion(version)),
		GRAPH_EXTRACT_ENABLED: "false",
		GRAPH_SEARCH_ENABLED: "false",
		SEARCH_EXPANSION_ENABLED: "false",
	});
}

async function launchRuntime(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
	root: string,
	version: string,
	options: Readonly<{
		workspaceEnabled?: "true" | "false";
		attachmentStorageEnforcement?: "true" | "false";
	}> = {},
): Promise<{ baseUrl: string; logs: ActiveRuntime }> {
	const port = await freePort();
	const child = Bun.spawn(["bun", "apps/api/src/oss-runtime.ts"], {
		cwd: root,
		env: runtimeEnvironment(prepared, port, version, options),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const logs: ActiveRuntime = {
		version,
		child,
		stdout: new Response(child.stdout).text(),
		stderr: new Response(child.stderr).text(),
	};
	prepared.activeRuntime = logs;
	const baseUrl = `http://127.0.0.1:${port}`;
	let lastStatus = "unreachable";
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (
			await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(0).then(() => false),
			])
		) {
			const [stdout, stderr] = await Promise.all([logs.stdout, logs.stderr]);
			prepared.activeRuntime = undefined;
			throw new Error(
				`BLOCKED: exact ${version} runtime exited before health: ${runner.redact(stdout + stderr)}`,
			);
		}
		try {
			const response = await fetch(`${baseUrl}/api/health`);
			lastStatus = String(response.status);
			if (response.ok) return { baseUrl, logs };
		} catch {
			lastStatus = "unreachable";
		}
		await Bun.sleep(250);
	}
	await stopRuntime(runner, prepared);
	throw new Error(`BLOCKED: exact ${version} runtime health was ${lastStatus}`);
}

interface AssertionPayload {
	actorUserId: string;
	workspaceId: string;
	actorRole: "owner";
	resourceScope?: {
		kind: "category";
		categoryId: string;
		permissions: Array<"read" | "edit" | "write">;
	};
	issuedAt: number;
	expiresAt: number;
	issuer: string;
}

async function signAssertion(
	prepared: ActualPreparedRehearsal,
	resourceScope?: AssertionPayload["resourceScope"],
): Promise<string> {
	const issuedAt = Math.floor(Date.now() / 1000);
	const payload: AssertionPayload = {
		actorUserId: prepared.userId,
		workspaceId: prepared.workspaceId,
		actorRole: "owner",
		...(resourceScope ? { resourceScope } : {}),
		issuedAt,
		expiresAt: issuedAt + 60,
		issuer: prepared.issuer,
	};
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
		"base64url",
	);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(prepared.assertionSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = Buffer.from(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)),
	).toString("base64url");
	return `${encoded}.${signature}`;
}

function assertionHeaders(assertion: string, apiKey: string): HeadersInit {
	return {
		"content-type": "application/json",
		authorization: `Bearer ${apiKey}`,
		"x-docsmint-workspace-context": assertion,
		"x-docsmint-graph-search": "disabled",
	};
}

async function apiRequest(
	baseUrl: string,
	apiKey: string,
	assertion: string,
	path: string,
	init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			...assertionHeaders(assertion, apiKey),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	let body: unknown;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	return { status: response.status, body };
}

function objectBody(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} returned a non-object body`);
	}
	return value as Record<string, unknown>;
}

function documentIds(value: unknown): string[] {
	const body = objectBody(value, "document collection");
	const items = body.items;
	if (!Array.isArray(items)) return [];
	return items.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const id = (item as Record<string, unknown>).id;
		return typeof id === "string" ? [id] : [];
	});
}

async function assertStatus(
	request: Promise<{ status: number; body: unknown }>,
	expected: number | number[],
	label: string,
): Promise<{ status: number; body: unknown }> {
	const result = await request;
	const statuses = Array.isArray(expected) ? expected : [expected];
	if (!statuses.includes(result.status)) {
		throw new Error(
			`${label} returned HTTP ${result.status}: ${JSON.stringify(result.body)}`,
		);
	}
	return result;
}

async function searchForDocument(
	baseUrl: string,
	apiKey: string,
	assertion: string,
	token: string,
	documentId: string,
): Promise<{ found: boolean; ids: string[] }> {
	let ids: string[] = [];
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const result = await assertStatus(
			apiRequest(
				baseUrl,
				apiKey,
				assertion,
				`/api/search/?q=${encodeURIComponent(token)}&limit=100`,
			),
			200,
			"search",
		);
		ids = documentIds(result.body);
		if (ids.includes(documentId)) return { found: true, ids };
		await Bun.sleep(250);
	}
	return { found: false, ids };
}

async function createDocument(
	baseUrl: string,
	apiKey: string,
	assertion: string,
	input: { title: string; content: string; categoryId: string },
): Promise<string> {
	const response = await assertStatus(
		apiRequest(baseUrl, apiKey, assertion, "/api/documents", {
			method: "POST",
			body: JSON.stringify(input),
		}),
		201,
		"create document",
	);
	const id = objectBody(response.body, "create document").id;
	if (typeof id !== "string")
		throw new Error("create document did not return an id");
	return id;
}

async function smoke070Actual(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<RuntimeSmokeEvidence> {
	const { baseUrl } = await launchRuntime(
		runner,
		prepared,
		prepared.hostRoot,
		OSS_CANDIDATE_VERSION,
	);
	try {
		const unscoped = await signAssertion(prepared);
		const commonToken = `scope-${prepared.token}`;
		const allowedId = await createDocument(baseUrl, prepared.apiKey, unscoped, {
			title: `${commonToken} allowed`,
			content: `${commonToken} allowed body`,
			categoryId: prepared.categoryA,
		});
		const foreignId = await createDocument(baseUrl, prepared.apiKey, unscoped, {
			title: `${commonToken} foreign`,
			content: `${commonToken} foreign body`,
			categoryId: prepared.categoryB,
		});
		prepared.rollbackDocumentId = foreignId;
		await assertStatus(
			apiRequest(
				baseUrl,
				prepared.apiKey,
				unscoped,
				`/api/documents/${allowedId}`,
			),
			200,
			"0.7 read",
		);
		await assertStatus(
			apiRequest(
				baseUrl,
				prepared.apiKey,
				unscoped,
				`/api/documents/${allowedId}`,
				{
					method: "PATCH",
					body: JSON.stringify({ title: `${commonToken} allowed updated` }),
				},
			),
			200,
			"0.7 update",
		);
		const scoped = await signAssertion(prepared, {
			kind: "category",
			categoryId: prepared.categoryA,
			permissions: ["read", "edit", "write"],
		});
		const list = await assertStatus(
			apiRequest(baseUrl, prepared.apiKey, scoped, "/api/documents?limit=100"),
			200,
			"0.7 scoped list",
		);
		const listedIds = documentIds(list.body);
		const allowedDocumentVisible = listedIds.includes(allowedId);
		const directForeign = await apiRequest(
			baseUrl,
			prepared.apiKey,
			scoped,
			`/api/documents/${foreignId}`,
		);
		const scopedSearch = await searchForDocument(
			baseUrl,
			prepared.apiKey,
			scoped,
			commonToken,
			allowedId,
		);
		const foreignDocumentHidden =
			!listedIds.includes(foreignId) &&
			directForeign.status === 404 &&
			!scopedSearch.ids.includes(foreignId);
		await assertStatus(
			apiRequest(
				baseUrl,
				prepared.apiKey,
				scoped,
				`/api/documents/${allowedId}`,
				{
					method: "DELETE",
				},
			),
			[200, 204],
			"0.7 delete",
		);
		const deleted = await apiRequest(
			baseUrl,
			prepared.apiKey,
			scoped,
			`/api/documents/${allowedId}`,
		);
		return {
			version: OSS_CANDIDATE_VERSION,
			health: true,
			crud: {
				create: true,
				read: true,
				update: true,
				delete: deleted.status === 404,
			},
			search: scopedSearch.found,
			assertionScope: { allowedDocumentVisible, foreignDocumentHidden },
		};
	} finally {
		await stopRuntime(runner, prepared);
	}
}

async function smoke068Actual(
	runner: SafeCommandRunner,
	prepared: ActualPreparedRehearsal,
): Promise<RuntimeSmokeEvidence> {
	if (!prepared.rollbackDocumentId) {
		throw new Error("0.7 smoke did not retain a rollback read fixture");
	}
	const { baseUrl } = await launchRuntime(
		runner,
		prepared,
		prepared.baselineRoot,
		"0.6.8",
	);
	try {
		const assertion = await signAssertion(prepared);
		await assertStatus(
			apiRequest(
				baseUrl,
				prepared.apiKey,
				assertion,
				`/api/documents/${prepared.rollbackDocumentId}`,
			),
			200,
			"0.6.8 read 0.7 document",
		);
		const token = `rollback-${prepared.token}`;
		const id = await createDocument(baseUrl, prepared.apiKey, assertion, {
			title: `${token} created by 0.6.8`,
			content: `${token} body`,
			categoryId: prepared.categoryA,
		});
		// The upgraded schema must remain writable by the exact 0.6.8 runtime,
		// whose quota-aware confirm insert omits attachments.uploaded_by.
		// Migration 0043 fills that attribution before the NOT NULL check. The
		// legacy multipart route is deliberately disabled in workspace mode, so
		// exercise the supported 0.6.8 presign -> PUT -> confirm contract instead.
		const attachmentBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x36, 0x38,
		]);
		const filename = `${token}.png`;
		const presign = await assertStatus(
			apiRequest(
				baseUrl,
				prepared.apiKey,
				assertion,
				`/api/documents/${id}/attachments/presign`,
				{
					method: "POST",
					body: JSON.stringify({
						filename,
						contentType: "image/png",
						size: attachmentBytes.byteLength,
					}),
				},
			),
			200,
			"0.6.8 attachment presign",
		);
		const presignBody = objectBody(presign.body, "0.6.8 attachment presign");
		const uploadUrl = presignBody.url;
		const storageKey = presignBody.key;
		const quotaReservationId = presignBody.quotaReservationId;
		if (
			typeof uploadUrl !== "string" ||
			typeof storageKey !== "string" ||
			typeof quotaReservationId !== "string"
		) {
			throw new Error("0.6.8 attachment presign omitted upload admission fields");
		}
		const put = await fetch(uploadUrl, {
			method: "PUT",
			headers: { "content-type": "image/png" },
			body: attachmentBytes,
		});
		if (!put.ok) {
			throw new Error(
				`0.6.8 attachment PUT returned HTTP ${put.status}: ${await put.text()}`,
			);
		}
		const confirmed = await assertStatus(
			apiRequest(
				baseUrl,
				prepared.apiKey,
				assertion,
				`/api/documents/${id}/attachments/confirm`,
				{
					method: "POST",
					body: JSON.stringify({
						key: storageKey,
						filename,
						contentType: "image/png",
						size: attachmentBytes.byteLength,
						quotaReservationId,
					}),
				},
			),
			201,
			"0.6.8 attachment confirm",
		);
		const attachmentId = objectBody(
			confirmed.body,
			"0.6.8 attachment confirm",
		).id;
		if (typeof attachmentId !== "string")
			throw new Error("0.6.8 attachment upload did not return an id");
		await assertStatus(
			apiRequest(
				baseUrl,
				prepared.apiKey,
				assertion,
				`/api/attachments/${attachmentId}`,
				{ method: "DELETE" },
			),
			[200, 204],
			"0.6.8 attachment cleanup",
		);
		await assertStatus(
			apiRequest(baseUrl, prepared.apiKey, assertion, `/api/documents/${id}`),
			200,
			"0.6.8 read",
		);
		await assertStatus(
			apiRequest(baseUrl, prepared.apiKey, assertion, `/api/documents/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ title: `${token} updated by 0.6.8` }),
			}),
			200,
			"0.6.8 update",
		);
		const search = await searchForDocument(
			baseUrl,
			prepared.apiKey,
			assertion,
			token,
			id,
		);
		await assertStatus(
			apiRequest(baseUrl, prepared.apiKey, assertion, `/api/documents/${id}`, {
				method: "DELETE",
			}),
			[200, 204],
			"0.6.8 delete",
		);
		const deleted = await apiRequest(
			baseUrl,
			prepared.apiKey,
			assertion,
			`/api/documents/${id}`,
		);
		return {
			version: "0.6.8",
			health: true,
			crud: {
				create: true,
				read: true,
				update: true,
				delete: deleted.status === 404,
			},
			search: search.found,
		};
	} finally {
		await stopRuntime(runner, prepared);
	}
}

async function main(): Promise<void> {
	const runner = new SafeCommandRunner();
	const candidateCommit = (
		await runner.run(["git", "rev-parse", "HEAD"], {
			cwd: REPOSITORY_ROOT,
			env: safeEnvironment(),
		})
	).stdout.trim();
	if (!COMMIT_PATTERN.test(candidateCommit))
		throw new Error("candidate is not a full Git SHA");
	verifyCandidateProvenance(
		await collectCandidateProvenance(runner, REPOSITORY_ROOT, candidateCommit),
	);
	let initialSiblingStatus: string | undefined;
	let preparedForSummary: ActualPreparedRehearsal | undefined;
	const report = await runRehearsalWorkflow<ActualPreparedRehearsal>(
		{
			async assertRealCheckoutClean(phase) {
				const status = (
					await runner.run(
						[
							"git",
							"status",
							"--porcelain=v1",
							"--untracked-files=all",
							"--ignore-submodules=none",
						],
						{ cwd: HOST_SOURCE_ROOT, env: safeEnvironment() },
					)
				).stdout;
				if (status.trim())
					throw new Error(`real downstream checkout is dirty ${phase}`);
				if (phase === "before") initialSiblingStatus = status;
				if (phase === "after" && status !== initialSiblingStatus) {
					throw new Error("real downstream checkout status changed during rehearsal");
				}
			},
			async prepare() {
				preparedForSummary = await prepareActualRehearsal(
					runner,
					candidateCommit,
				);
				return preparedForSummary;
			},
			packAndAdopt: (prepared) => packAndAdoptActual(runner, prepared),
			migrate: (prepared) => migrateActual(runner, prepared),
			probeEnvironment: (prepared) => probeEnvironmentActual(runner, prepared),
			smoke070: (prepared) => smoke070Actual(runner, prepared),
			smoke068: (prepared) => smoke068Actual(runner, prepared),
			cleanup: (prepared) => cleanupActualRehearsal(runner, prepared),
		},
		{ candidateCommit, packageManifests: PACKAGE_MANIFESTS },
	);
	console.log(
		JSON.stringify(
			{
				status: "PASS",
				candidateCommit,
				adoptionCommit: report.adoption.adoptionCommit,
				migration: report.migration,
				newRequiredEnvironmentKeys: report.environment.newRequiredKeys,
				runtimes: [report.runtime070.version, report.runtime068.version],
				realHostCheckoutClean: true,
				resources: preparedForSummary
					? {
							temporaryRoot: preparedForSummary.root,
							databaseName: preparedForSummary.databaseName,
							ownerRole: preparedForSummary.ownerRole,
							runtimeRole: preparedForSummary.runtimeRole,
							redisPort: preparedForSummary.redisPort,
							storageBucket: preparedForSummary.storageBucket,
						}
					: undefined,
				cleanup: {
					temporaryRootRemoved: Boolean(preparedForSummary),
					databaseDropped: Boolean(preparedForSummary?.postgresCreated),
					rolesDropped: Boolean(preparedForSummary?.postgresCreated),
					redisNamespaceStopped: Boolean(
						preparedForSummary?.redisServer?.stopped,
					),
					storageBucketDeleted: Boolean(
						preparedForSummary?.storageBucketCreated,
					),
				},
			},
			null,
			2,
		),
	);
}

if (import.meta.main) {
	main().catch((error) => {
		const message = redactSecrets(
			error instanceof Error ? error.message : String(error),
			[...REGISTERED_SECRETS],
		);
		console.error(
			message.startsWith("BLOCKED:") ? message : `BLOCKED: ${message}`,
		);
		process.exitCode = 1;
	});
}
