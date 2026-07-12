export type ProviderLimiterMode = "disabled" | "local" | "remote";

export interface ProviderLimiterProfile {
	name: string;
	mode: ProviderLimiterMode;
	maxConcurrency?: number;
	requestsPerMinute?: number;
	maxRetries?: number;
	baseBackoffMs?: number;
	circuitFailureThreshold?: number;
	circuitCooldownMs?: number;
}

export interface ProviderLimiterRuntime {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

type PermitRelease = () => void;

class Semaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async acquire(): Promise<PermitRelease> {
		if (this.active >= this.limit) {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		this.active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			this.waiters.shift()?.();
		};
	}
}

function retryAfterMs(error: unknown): number | null {
	if (!error || typeof error !== "object") return null;
	const candidate = error as {
		status?: number;
		retryAfterMs?: number;
		response?: { status?: number; headers?: Headers | Record<string, string> };
	};
	if (typeof candidate.retryAfterMs === "number") return candidate.retryAfterMs;
	const headers = candidate.response?.headers;
	const value =
		headers instanceof Headers
			? headers.get("retry-after")
			: headers?.["retry-after"];
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function retryable(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as {
		status?: number;
		response?: { status?: number };
	};
	const status = candidate.status ?? candidate.response?.status;
	return status === 429 || (typeof status === "number" && status >= 500);
}

export function createProviderLimiter(runtime: ProviderLimiterRuntime = {}) {
	const now = runtime.now ?? Date.now;
	const sleep = runtime.sleep ?? ((ms: number) => Bun.sleep(ms));
	const semaphores = new Map<string, Semaphore>();
	const requestWindows = new Map<string, number[]>();
	const circuits = new Map<string, { failures: number; openUntil: number }>();

	async function waitForRateWindow(key: string, requestsPerMinute: number) {
		if (requestsPerMinute <= 0) return;
		while (true) {
			const current = now();
			const window = (requestWindows.get(key) ?? []).filter(
				(timestamp) => current - timestamp < 60_000,
			);
			if (window.length < requestsPerMinute) {
				window.push(current);
				requestWindows.set(key, window);
				return;
			}
			await sleep(Math.max(1, 60_000 - (current - (window[0] ?? current))));
		}
	}

	return async function withPermit<T>(
		profile: ProviderLimiterProfile,
		operation: string,
		fn: () => Promise<T>,
	): Promise<T> {
		if (profile.mode === "disabled") return fn();
		const key = `${profile.name}:${operation}`;
		const circuit = circuits.get(key);
		if (circuit && circuit.openUntil > now()) {
			throw Object.assign(new Error("provider_circuit_open"), {
				code: "provider_circuit_open",
				retryable: true,
			});
		}
		const concurrency = profile.maxConcurrency ?? 1;
		if (!Number.isInteger(concurrency) || concurrency < 1) {
			throw new Error("Provider maxConcurrency must be a positive integer");
		}
		let semaphore = semaphores.get(key);
		if (!semaphore) {
			semaphore = new Semaphore(concurrency);
			semaphores.set(key, semaphore);
		}
		const release = await semaphore.acquire();
		try {
			const maxRetries =
				profile.mode === "remote" ? (profile.maxRetries ?? 3) : 0;
			for (let attempt = 0; ; attempt += 1) {
				if (profile.mode === "remote") {
					await waitForRateWindow(key, profile.requestsPerMinute ?? 0);
				}
				try {
					const value = await fn();
					circuits.delete(key);
					return value;
				} catch (error) {
					if (attempt >= maxRetries || !retryable(error)) {
						if (retryable(error)) {
							const state = circuits.get(key) ?? { failures: 0, openUntil: 0 };
							state.failures += 1;
							if (state.failures >= (profile.circuitFailureThreshold ?? 5)) {
								state.openUntil = now() + (profile.circuitCooldownMs ?? 30_000);
							}
							circuits.set(key, state);
						}
						throw error;
					}
					const retryAfter = retryAfterMs(error);
					const exponential = (profile.baseBackoffMs ?? 250) * 2 ** attempt;
					await sleep(retryAfter ?? exponential);
				}
			}
		} finally {
			release();
		}
	};
}

const defaultLimiter = createProviderLimiter();

export function withProviderPermit<T>(
	profile: ProviderLimiterProfile,
	operation: string,
	fn: () => Promise<T>,
): Promise<T> {
	return defaultLimiter(profile, operation, fn);
}
