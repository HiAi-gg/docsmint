export type GradedRelevance = Record<string, number>;

export function dcg(gains: number[]): number {
	return gains.reduce(
		(sum, gain, index) => sum + gain / Math.log2(index + 2),
		0,
	);
}

export function ndcgAt(
	rankedIds: string[],
	labels: GradedRelevance,
	k: number,
): number {
	const actual = rankedIds
		.slice(0, k)
		.map((id) => Math.max(0, labels[id] ?? 0));
	const ideal = Object.values(labels)
		.filter((gain) => gain > 0)
		.sort((left, right) => right - left)
		.slice(0, k);
	const denom = dcg(ideal);
	if (denom === 0) return 0;
	return dcg(actual) / denom;
}

export function mrr(rankedIds: string[], labels: GradedRelevance): number {
	const index = rankedIds.findIndex((id) => (labels[id] ?? 0) >= 2);
	return index === -1 ? 0 : 1 / (index + 1);
}

export function precisionAt(
	rankedIds: string[],
	labels: GradedRelevance,
	k: number,
	minGain = 2,
): number {
	const window = rankedIds.slice(0, k);
	if (window.length === 0) return 0;
	const hits = window.filter((id) => (labels[id] ?? 0) >= minGain).length;
	return hits / window.length;
}

export function recallAt(
	rankedIds: string[],
	labels: GradedRelevance,
	k: number,
	minGain = 2,
): number {
	const relevant = Object.entries(labels)
		.filter(([, gain]) => gain >= minGain)
		.map(([id]) => id);
	if (relevant.length === 0) return 0;
	const window = new Set(rankedIds.slice(0, k));
	return relevant.filter((id) => window.has(id)).length / relevant.length;
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[index] ?? 0;
}
