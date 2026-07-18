/** Server-only, persistence-agnostic storage quota contract. */

export type StorageQuotaContext = Readonly<{
	actorUserId: string;
	requestId: string;
	idempotencyKey: string;
	signal?: AbortSignal;
}>;

export type StorageQuotaReservationRequest = StorageQuotaContext &
	Readonly<{ bytes: number }>;

export type StorageQuotaReservation = Readonly<{
	status: "reserved" | "already_reserved";
	reservationId: string;
	reservedBytes: number;
	usageBytes: number;
	limitBytes: number;
	expiresAt: string;
}>;

export type StorageQuotaRejection = Readonly<{
	status: "rejected";
	usageBytes: number;
	limitBytes: number;
	requestedBytes: number;
}>;

export type StorageQuotaCommitRequest = StorageQuotaContext &
	Readonly<{
		reservationId: string;
		actualBytes: number;
	}>;

export type StorageQuotaReleaseRequest = StorageQuotaContext &
	Readonly<{ reservationId: string }>;

export type StorageQuotaCommitResult = Readonly<{
	status: "committed" | "already_committed";
}>;

export type StorageQuotaReleaseResult = Readonly<{
	status: "released" | "already_released" | "not_found";
}>;

export type StorageQuotaAdapter = Readonly<{
	/** Must atomically check usage and create an idempotent reservation. */
	reserve(
		request: StorageQuotaReservationRequest,
	): Promise<StorageQuotaReservation | StorageQuotaRejection>;
	commit(request: StorageQuotaCommitRequest): Promise<StorageQuotaCommitResult>;
	release(
		request: StorageQuotaReleaseRequest,
	): Promise<StorageQuotaReleaseResult>;
}>;

export type StorageQuotaService = Readonly<{
	reserve(request: StorageQuotaReservationRequest): Promise<StorageQuotaReservation>;
	commit(request: StorageQuotaCommitRequest): Promise<StorageQuotaCommitResult>;
	release(request: StorageQuotaReleaseRequest): Promise<StorageQuotaReleaseResult>;
}>;

export class StorageQuotaExceededError extends Error {
	readonly code = "STORAGE_QUOTA_EXCEEDED" as const;
	readonly usageBytes: number;
	readonly limitBytes: number;
	readonly requestedBytes: number;

	constructor(rejection: StorageQuotaRejection) {
		super("Storage quota exceeded");
		this.name = "StorageQuotaExceededError";
		this.usageBytes = rejection.usageBytes;
		this.limitBytes = rejection.limitBytes;
		this.requestedBytes = rejection.requestedBytes;
	}
}

function assertContext(context: StorageQuotaContext): void {
	for (const [name, value] of [
		["actorUserId", context.actorUserId],
		["requestId", context.requestId],
		["idempotencyKey", context.idempotencyKey],
	] as const) {
		if (!value.trim()) throw new TypeError(`${name} must not be empty`);
	}
	if (context.signal?.aborted) {
		throw new DOMException("Storage quota operation aborted", "AbortError");
	}
}

function assertPositiveBytes(bytes: number, name: string): void {
	if (!Number.isSafeInteger(bytes) || bytes <= 0) {
		throw new TypeError(`${name} must be a positive safe integer`);
	}
}

function assertNonnegativeBytes(bytes: number, name: string): void {
	if (!Number.isSafeInteger(bytes) || bytes < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer`);
	}
}

function assertReservation(result: StorageQuotaReservation): void {
	assertReservationId(result.reservationId);
	assertPositiveBytes(result.reservedBytes, "reservedBytes");
	assertNonnegativeBytes(result.usageBytes, "usageBytes");
	assertNonnegativeBytes(result.limitBytes, "limitBytes");
	if (Number.isNaN(Date.parse(result.expiresAt))) {
		throw new TypeError("expiresAt must be an ISO-compatible timestamp");
	}
}

function assertRejection(result: StorageQuotaRejection): void {
	assertNonnegativeBytes(result.usageBytes, "usageBytes");
	assertNonnegativeBytes(result.limitBytes, "limitBytes");
	assertPositiveBytes(result.requestedBytes, "requestedBytes");
}

function assertReservationId(value: string): void {
	if (!value.trim()) throw new TypeError("reservationId must not be empty");
}

export function createStorageQuotaService(
	adapter: StorageQuotaAdapter,
): StorageQuotaService {
	return Object.freeze({
		async reserve(
			request: StorageQuotaReservationRequest,
		): Promise<StorageQuotaReservation> {
			assertContext(request);
			assertPositiveBytes(request.bytes, "bytes");
			const result = await adapter.reserve(Object.freeze({ ...request }));
			if (result.status === "rejected") {
				assertRejection(result);
				throw new StorageQuotaExceededError(result);
			}
			assertReservation(result);
			return Object.freeze({ ...result });
		},
		async commit(
			request: StorageQuotaCommitRequest,
		): Promise<StorageQuotaCommitResult> {
			assertContext(request);
			assertReservationId(request.reservationId);
			assertPositiveBytes(request.actualBytes, "actualBytes");
			const result = await adapter.commit(Object.freeze({ ...request }));
			if (result.status !== "committed" && result.status !== "already_committed") {
				throw new TypeError("Storage quota adapter returned an invalid commit status");
			}
			return Object.freeze({ ...result });
		},
		async release(
			request: StorageQuotaReleaseRequest,
		): Promise<StorageQuotaReleaseResult> {
			assertContext(request);
			assertReservationId(request.reservationId);
			const result = await adapter.release(Object.freeze({ ...request }));
			if (
				result.status !== "released" &&
				result.status !== "already_released" &&
				result.status !== "not_found"
			) {
				throw new TypeError("Storage quota adapter returned an invalid release status");
			}
			return Object.freeze({ ...result });
		},
	});
}
