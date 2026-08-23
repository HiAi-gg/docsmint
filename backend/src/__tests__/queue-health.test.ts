import { describe, expect, it } from "bun:test";
import {
	emptyPipelineMetricSnapshot,
	evaluatePipelineHealth,
	PIPELINE_METRIC_NAMES,
} from "../queue/health";

describe("pipeline health contracts", () => {
	it("creates fixed-cardinality metric snapshots", () => {
		const snapshot = emptyPipelineMetricSnapshot();
		expect(Object.keys(snapshot)).toHaveLength(43);
		expect(Object.keys(snapshot)).toEqual([...PIPELINE_METRIC_NAMES]);
	});

	it("reports optional graph outage as degraded, not unhealthy", () => {
		expect(
			evaluatePipelineHealth({
				databaseAvailable: true,
				redisAvailable: true,
				storageAvailable: true,
				queueAvailable: true,
				recoveryAvailable: true,
				oldestInteractiveWaitMs: 10,
				interactiveSloMs: 100,
				graphAvailable: false,
			}),
		).toEqual({
			status: "degraded",
			degraded: { graph: "provider_unavailable" },
			reasons: [],
		});
	});

	it("marks queue unhealthy for Redis or recovery/SLO failures", () => {
		const report = evaluatePipelineHealth({
			databaseAvailable: true,
			redisAvailable: false,
			storageAvailable: true,
			queueAvailable: true,
			recoveryAvailable: true,
			oldestInteractiveWaitMs: 200,
			interactiveSloMs: 100,
			graphAvailable: true,
		});
		expect(report.status).toBe("unhealthy");
		expect(report.reasons).toEqual([
			"redis_unavailable",
			"interactive_slo_breached",
		]);
	});

	it("marks readiness unhealthy when any required service is unavailable", () => {
		for (const unavailable of [
			"databaseAvailable",
			"storageAvailable",
			"queueAvailable",
		] as const) {
			const report = evaluatePipelineHealth({
				redisAvailable: true,
				recoveryAvailable: true,
				oldestInteractiveWaitMs: 0,
				interactiveSloMs: 100,
				graphAvailable: true,
				databaseAvailable: true,
				storageAvailable: true,
				queueAvailable: true,
				[unavailable]: false,
			});

			expect(report.status).toBe("unhealthy");
			expect(report.reasons).toContain(
				unavailable.replace("Available", "_unavailable"),
			);
		}
	});
});
