import { describe, expect, mock, test } from "bun:test";
import {
	createStorageQuotaService,
	StorageQuotaExceededError,
} from "./storage-quota";

const context = Object.freeze({
	actorUserId: "11111111-1111-4111-8111-111111111111",
	requestId: "request-1",
	idempotencyKey: "upload-1",
});

describe("storage quota service", () => {
	test("returns an immutable atomic reservation", async () => {
		const reserve = mock(async () => ({
			status: "reserved" as const,
			reservationId: "reservation-1",
			reservedBytes: 512,
			usageBytes: 1_024,
			limitBytes: 4_096,
			expiresAt: "2026-07-18T20:00:00.000Z",
		}));
		const service = createStorageQuotaService({
			reserve,
			commit: async () => ({ status: "committed" as const }),
			release: async () => ({ status: "released" as const }),
		});

		const reservation = await service.reserve({ ...context, bytes: 512 });
		expect(reserve).toHaveBeenCalledWith({ ...context, bytes: 512 });
		expect(Object.isFrozen(reservation)).toBe(true);
		expect(reservation.reservationId).toBe("reservation-1");
	});

	test("throws a redacted typed error when the atomic adapter rejects quota", async () => {
		const service = createStorageQuotaService({
			reserve: async () => ({
				status: "rejected" as const,
				usageBytes: 4_000,
				limitBytes: 4_096,
				requestedBytes: 512,
			}),
			commit: async () => ({ status: "committed" as const }),
			release: async () => ({ status: "released" as const }),
		});

		await expect(service.reserve({ ...context, bytes: 512 })).rejects.toEqual(
			expect.objectContaining({
				name: "StorageQuotaExceededError",
				code: "STORAGE_QUOTA_EXCEEDED",
			}),
		);
		try {
			await service.reserve({ ...context, bytes: 512 });
		} catch (error) {
			expect(error).toBeInstanceOf(StorageQuotaExceededError);
			expect(String(error)).not.toContain(context.actorUserId);
		}
	});

	test("validates byte counts before calling an adapter", async () => {
		const reserve = mock(async () => {
			throw new Error("must not run");
		});
		const service = createStorageQuotaService({
			reserve,
			commit: async () => ({ status: "committed" as const }),
			release: async () => ({ status: "released" as const }),
		});
		await expect(service.reserve({ ...context, bytes: 0 })).rejects.toThrow(
			"positive safe integer",
		);
		expect(reserve).not.toHaveBeenCalled();
	});

	test("commits and releases reservations through immutable retry-safe requests", async () => {
		const commit = mock(async () => ({ status: "already_committed" as const }));
		const release = mock(async () => ({ status: "already_released" as const }));
		const service = createStorageQuotaService({
			reserve: async () => ({
				status: "reserved" as const,
				reservationId: "reservation-1",
				reservedBytes: 1,
				usageBytes: 0,
				limitBytes: 2,
				expiresAt: "2026-07-18T20:00:00.000Z",
			}),
			commit,
			release,
		});
		const committed = await service.commit({
			...context,
			reservationId: "reservation-1",
			actualBytes: 512,
		});
		const released = await service.release({
			...context,
			reservationId: "reservation-1",
		});
		expect(committed.status).toBe("already_committed");
		expect(released.status).toBe("already_released");
		expect(Object.isFrozen(commit.mock.calls[0]?.[0])).toBe(true);
		expect(Object.isFrozen(release.mock.calls[0]?.[0])).toBe(true);
	});
});
