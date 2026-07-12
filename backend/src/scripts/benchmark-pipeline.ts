export interface PipelineBenchmarkSample {
	ownerId: string;
	queueWaitMs: number;
	processingMs: number;
	failed?: boolean;
	providerCalls?: number;
}

export interface PipelineBenchmarkReport {
	sampleCount: number;
	throughputPerMinute: number;
	queueWaitMs: { p50: number; p95: number };
	processingMs: { p50: number; p95: number };
	failureRate: number;
	fairness: {
		ownerCount: number;
		minCompleted: number;
		maxCompleted: number;
		spread: number;
	};
	providerCalls: number;
}

function percentile(values: number[], rank: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.ceil(rank * sorted.length) - 1,
	);
	return sorted[Math.max(0, index)] ?? 0;
}

/** Build a hardware-independent baseline report from completed pipeline samples. */
export function buildPipelineBenchmarkReport(
	samples: readonly PipelineBenchmarkSample[],
	durationMs: number,
): PipelineBenchmarkReport {
	const queueWait = samples.map((sample) => sample.queueWaitMs);
	const processing = samples.map((sample) => sample.processingMs);
	const completedByOwner = new Map<string, number>();
	for (const sample of samples) {
		if (!sample.failed)
			completedByOwner.set(
				sample.ownerId,
				(completedByOwner.get(sample.ownerId) ?? 0) + 1,
			);
		else if (!completedByOwner.has(sample.ownerId))
			completedByOwner.set(sample.ownerId, 0);
	}
	const counts = [...completedByOwner.values()];
	const minCompleted = counts.length ? Math.min(...counts) : 0;
	const maxCompleted = counts.length ? Math.max(...counts) : 0;
	return {
		sampleCount: samples.length,
		throughputPerMinute:
			durationMs > 0 ? (samples.length * 60_000) / durationMs : 0,
		queueWaitMs: {
			p50: percentile(queueWait, 0.5),
			p95: percentile(queueWait, 0.95),
		},
		processingMs: {
			p50: percentile(processing, 0.5),
			p95: percentile(processing, 0.95),
		},
		failureRate: samples.length
			? samples.filter((sample) => sample.failed).length / samples.length
			: 0,
		fairness: {
			ownerCount: counts.length,
			minCompleted,
			maxCompleted,
			spread: maxCompleted - minCompleted,
		},
		providerCalls: samples.reduce(
			(total, sample) => total + (sample.providerCalls ?? 0),
			0,
		),
	};
}

if (import.meta.main) {
	console.log(
		"Use buildPipelineBenchmarkReport(samples, durationMs) from the benchmark harness.",
	);
}
