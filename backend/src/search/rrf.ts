import type {
	ChannelResult,
	RankedSearchResult,
	RrfOptions,
	SearchCandidate,
	SearchChannel,
	SearchExplanation,
} from "./types";

const DEFAULTS: Required<RrfOptions> = {
	rrfK: 60,
	exactBoost: 0.02,
	channelAgreementBoost: 0.01,
	graphMaxContribution: 0.03,
	vectorMinSimilarity: 0.35,
};

const LABELS: Record<SearchChannel, string> = {
	exact: "Exact title match",
	fts: "Text match",
	fuzzy: "Similar text match",
	vector: "Semantic match",
	expanded_fts: "Expanded text match",
	expanded_fuzzy: "Expanded similar text match",
	expanded_vector: "Semantic match",
	graph: "Related document",
};

function flatten(
	candidates: SearchCandidate[] | ChannelResult[],
): SearchCandidate[] {
	if (candidates.length === 0) return [];
	const [first] = candidates;
	if (!first) return [];
	return "candidates" in first
		? (candidates as ChannelResult[]).flatMap((result) => result.candidates)
		: (candidates as SearchCandidate[]);
}

function explanation(candidate: SearchCandidate): SearchExplanation {
	return {
		channel: candidate.channel,
		label: LABELS[candidate.channel],
		...(candidate.queryVariant ? { queryVariant: candidate.queryVariant } : {}),
	};
}

/** Fuse ranked channel candidates deterministically using reciprocal rank fusion. */
export function fuseCandidates(
	input: SearchCandidate[] | ChannelResult[],
	options: RrfOptions = {},
): RankedSearchResult[] {
	const config = { ...DEFAULTS, ...options };
	const bestByDocument = new Map<string, Map<SearchChannel, SearchCandidate>>();

	for (const candidate of flatten(input)) {
		if (
			!candidate.documentId ||
			!Number.isInteger(candidate.rank) ||
			candidate.rank < 1
		)
			continue;
		if (
			candidate.channel === "vector" ||
			candidate.channel === "expanded_vector"
		) {
			if (
				typeof candidate.rawScore !== "number" ||
				!Number.isFinite(candidate.rawScore)
			)
				continue;
			if (candidate.rawScore < config.vectorMinSimilarity) continue;
		}
		const byChannel =
			bestByDocument.get(candidate.documentId) ??
			new Map<SearchChannel, SearchCandidate>();
		const previous = byChannel.get(candidate.channel);
		if (!previous || candidate.rank < previous.rank)
			byChannel.set(candidate.channel, candidate);
		bestByDocument.set(candidate.documentId, byChannel);
	}

	const fused: RankedSearchResult[] = [];
	for (const [documentId, byChannel] of bestByDocument) {
		const channels = [...byChannel.keys()].sort();
		const explanations = [...byChannel.values()]
			.sort(
				(left, right) =>
					left.rank - right.rank || left.channel.localeCompare(right.channel),
			)
			.map(explanation);
		let score = 0;
		for (const candidate of byChannel.values()) {
			const contribution = 1 / (config.rrfK + candidate.rank);
			score +=
				candidate.channel === "graph"
					? Math.min(contribution, config.graphMaxContribution)
					: contribution;
		}
		if (byChannel.has("exact")) score += config.exactBoost;
		if (channels.length >= 2) score += config.channelAgreementBoost;
		if (byChannel.size === 1 && byChannel.has("graph"))
			score = Math.min(score, config.graphMaxContribution);
		fused.push({ documentId, score, channels, explanations });
	}

	return fused.sort(
		(left, right) =>
			right.score - left.score ||
			left.documentId.localeCompare(right.documentId),
	);
}

export const rankCandidates = fuseCandidates;
