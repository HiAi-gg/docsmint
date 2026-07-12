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
				redisAvailable: true,
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
			redisAvailable: false,
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
});
