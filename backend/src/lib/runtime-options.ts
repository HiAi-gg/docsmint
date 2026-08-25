import { config } from "./config";

/**
 * Process-local runtime options installed before the backend module graph is
 * imported by the public in-process launcher.  This never crosses HTTP.
 */
export type RuntimeAttachmentQuotaContext = Readonly<{
	workspaceId: string;
	actorUserId: string;
	documentId: string;
	storageKey: string;
	proposedSize: number;
	requestId: string;
	idempotencyKey: string;
	signal?: AbortSignal;
}>;

export type RuntimeAttachmentQuotaAdmission = Readonly<{
	/** Retry-safe by context.idempotencyKey; returns one stable reservation. */
	reserve(
		context: RuntimeAttachmentQuotaContext,
	): Promise<Readonly<{ id: string }>>;
	/** Retry-safe by context.idempotencyKey; commits usage at most once. */
	finalize(
		context: RuntimeAttachmentQuotaContext,
		finalization: Readonly<{ reservationId: string; actualSize: number }>,
	): Promise<void>;
	/** Retry-safe by context.idempotencyKey; repeated release is a no-op. */
	releaseReservation(
		context: RuntimeAttachmentQuotaContext,
		reservationId: string,
	): Promise<void>;
	/** Retry-safe by context.idempotencyKey; repeated release is a no-op. */
	releaseCommitted(context: RuntimeAttachmentQuotaContext): Promise<void>;
}>;

export type DocsMintRuntimeOptions = Readonly<{
	attachmentStorageQuotaAdmission?: RuntimeAttachmentQuotaAdmission;
}>;

const RUNTIME_OPTIONS = Symbol.for("@hiai-gg/docsmint/runtime-options");

export function configureDocsMintRuntime(
	options: DocsMintRuntimeOptions = {},
): void {
	const globals = globalThis as Record<PropertyKey, unknown>;
	const existing = globals[RUNTIME_OPTIONS] as
		| DocsMintRuntimeOptions
		| undefined;
	if (existing) return;
	if (
		config.DOCSMINT_WORKSPACE_ENABLED &&
		!options.attachmentStorageQuotaAdmission
	) {
		throw new Error(
			"Attachment storage quota admission is required when workspace tenancy is enabled",
		);
	}
	Object.defineProperty(globals, RUNTIME_OPTIONS, {
		value: Object.freeze({ ...options }),
		configurable: false,
		writable: false,
	});
}

export function getDocsMintRuntimeOptions():
	| DocsMintRuntimeOptions
	| undefined {
	return (globalThis as Record<PropertyKey, unknown>)[RUNTIME_OPTIONS] as
		| DocsMintRuntimeOptions
		| undefined;
}
