import { beforeEach, describe, expect, test } from "bun:test";
import {
	getPipelineMetrics,
	incrementPipelineMetric,
	resetMetrics,
	setPipelineMetric,
} from "../lib/metrics";
import { PIPELINE_METRIC_NAMES } from "../queue/health";

describe("fixed-cardinality BullMQ metrics", () => {
	beforeEach(() => resetMetrics());

	test("always exposes the complete stage metric contract", () => {
		const snapshot = getPipelineMetrics();
		expect(Object.keys(snapshot)).toEqual([...PIPELINE_METRIC_NAMES]);
		expect(Object.values(snapshot).every((value) => value === 0)).toBe(true);
	});

	test("supports gauges and monotonic stage counters without new keys", () => {
		setPipelineMetric("pipeline_embed_waiting", 7);
		incrementPipelineMetric("pipeline_embed_completed_total");
		incrementPipelineMetric("pipeline_embed_completed_total", 2);
		const snapshot = getPipelineMetrics();
		expect(snapshot.pipeline_embed_waiting).toBe(7);
		expect(snapshot.pipeline_embed_completed_total).toBe(3);
		expect(Object.keys(snapshot)).toHaveLength(PIPELINE_METRIC_NAMES.length);
	});

	test("ignores negative and non-finite observations", () => {
		setPipelineMetric("pipeline_graph_active", -1);
		incrementPipelineMetric("pipeline_graph_failed_total", Number.NaN);
		expect(getPipelineMetrics().pipeline_graph_active).toBe(0);
		expect(getPipelineMetrics().pipeline_graph_failed_total).toBe(0);
	});
});
