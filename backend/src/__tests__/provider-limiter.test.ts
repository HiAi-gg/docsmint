import { describe, expect, test } from "bun:test";
import { createProviderLimiter } from "../queue/provider-limiter";

describe("provider limiter", () => {
	test("opens and cools down a circuit after repeated remote failures", async () => {
		let now = 0;
		const permit = createProviderLimiter({
			now: () => now,
			sleep: async () => undefined,
		});
		const profile = {
			name: "remote",
			mode: "remote" as const,
			maxRetries: 0,
			circuitFailureThreshold: 2,
			circuitCooldownMs: 100,
		};
		const fail = () => Promise.reject({ status: 503 });
		await expect(permit(profile, "embed", fail)).rejects.toBeTruthy();
		await expect(permit(profile, "embed", fail)).rejects.toBeTruthy();
		await expect(permit(profile, "embed", async () => "ok")).rejects.toThrow(
			"provider_circuit_open",
		);
		now = 101;
		expect(await permit(profile, "embed", async () => "ok")).toBe("ok");
	});
	test("disabled mode applies no artificial quota or concurrency bound", async () => {
		const limiter = createProviderLimiter();
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 5 }, () =>
				limiter(
					{ name: "local", mode: "disabled", maxConcurrency: 1 },
					"embed",
					async () => {
						active += 1;
						peak = Math.max(peak, active);
						await Bun.sleep(2);
						active -= 1;
					},
				),
			),
		);
		expect(peak).toBe(5);
	});

	test("local mode caps concurrency but never applies RPM retries", async () => {
		const limiter = createProviderLimiter();
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 4 }, () =>
				limiter(
					{ name: "ollama", mode: "local", maxConcurrency: 2 },
					"embed",
					async () => {
						active += 1;
						peak = Math.max(peak, active);
						await Bun.sleep(2);
						active -= 1;
					},
				),
			),
		);
		expect(peak).toBe(2);
	});

	test("remote mode retries with Retry-After before exponential backoff", async () => {
		const sleeps: number[] = [];
		const limiter = createProviderLimiter({
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		let calls = 0;
		const result = await limiter(
			{
				name: "openrouter",
				mode: "remote",
				maxConcurrency: 1,
				requestsPerMinute: 0,
				maxRetries: 2,
				baseBackoffMs: 100,
			},
			"graph",
			async () => {
				calls += 1;
				if (calls === 1) throw { status: 429, retryAfterMs: 750 };
				if (calls === 2) throw { status: 503 };
				return "ok";
			},
		);
		expect(result).toBe("ok");
		expect(calls).toBe(3);
		expect(sleeps).toEqual([750, 200]);
	});

	test("remote RPM zero means unlimited", async () => {
		const limiter = createProviderLimiter({
			sleep: async () => {
				throw new Error("unlimited RPM must not sleep");
			},
		});
		await expect(
			Promise.all(
				Array.from({ length: 4 }, () =>
					limiter(
						{
							name: "remote",
							mode: "remote",
							maxConcurrency: 4,
							requestsPerMinute: 0,
						},
						"embed",
						async () => "ok",
					),
				),
			),
		).resolves.toEqual(["ok", "ok", "ok", "ok"]);
	});
});
