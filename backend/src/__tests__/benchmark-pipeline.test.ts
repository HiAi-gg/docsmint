import { describe, expect, it } from "bun:test";
import { buildPipelineBenchmarkReport } from "../scripts/benchmark-pipeline";

describe("pipeline benchmark report", () => {
	it("reports p50/p95, throughput, failures, fairness, and provider calls", () => {
		const report = buildPipelineBenchmarkReport(
			[
				{ ownerId: "a", queueWaitMs: 10, processingMs: 100, providerCalls: 2 },
				{
					ownerId: "a",
					queueWaitMs: 20,
					processingMs: 200,
					failed: true,
					providerCalls: 1,
				},
				{ ownerId: "b", queueWaitMs: 30, processingMs: 300, providerCalls: 3 },
			],
			60_000,
		);
		expect(report.sampleCount).toBe(3);
		expect(report.throughputPerMinute).toBe(3);
		expect(report.queueWaitMs).toEqual({ p50: 20, p95: 30 });
		expect(report.processingMs).toEqual({ p50: 200, p95: 300 });
		expect(report.failureRate).toBeCloseTo(1 / 3);
		expect(report.fairness).toEqual({
			ownerCount: 2,
			minCompleted: 1,
			maxCompleted: 1,
			spread: 0,
		});
		expect(report.providerCalls).toBe(6);
	});
});
