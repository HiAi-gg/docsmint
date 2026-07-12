import type {
	ChannelResult,
	ConfidenceResult,
	ConfidenceThresholds,
	ExpansionReason,
	QueryPlan,
	SearchCandidate,
} from "./types";

const LEXICAL_CHANNELS = new Set(["exact", "fts", "fuzzy"]);
const DIRECT_CHANNELS = new Set(["exact", "fts", "fuzzy", "vector"]);

function flatten(
	results: ChannelResult[] | SearchCandidate[],
): SearchCandidate[] {
	if (results.length === 0) return [];
	const [first] = results;
	if (!first) return [];
	return "candidates" in first
		? (results as ChannelResult[]).flatMap((result) => result.candidates)
		: (results as SearchCandidate[]);
}

/** Decide whether one structured expansion pass is justified by fast-pass evidence. */
export function evaluateConfidence(
	results: ChannelResult[] | SearchCandidate[],
	_plan?: QueryPlan,
	thresholds: ConfidenceThresholds = { vectorMinSimilarity: 0.35 },
): ConfidenceResult {
	const minChannelAgreement = Math.max(
		1,
		Math.floor(thresholds.minChannelAgreement ?? 2),
	);
	const candidates = flatten(results);
	if (candidates.length === 0)
		return {
			confident: false,
			reasons: [
				"empty_candidates",
				...(thresholds.languageMismatch ? ["language_mismatch" as const] : []),
			],
		};

	const reasons: ExpansionReason[] = [];
	const lexical = candidates.filter((candidate) =>
		LEXICAL_CHANNELS.has(candidate.channel),
	);
	if (lexical.length === 0) reasons.push("no_lexical_match");

	const channelByDocument = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		if (!DIRECT_CHANNELS.has(candidate.channel)) continue;
		const channels =
			channelByDocument.get(candidate.documentId) ?? new Set<string>();
		channels.add(candidate.channel);
		channelByDocument.set(candidate.documentId, channels);
	}
	const hasAgreement = [...channelByDocument.values()].some(
		(channels) => channels.size >= minChannelAgreement,
	);
	if (!hasAgreement) reasons.push("low_channel_agreement");

	const vectorScores = candidates
		.filter((candidate) => candidate.channel === "vector")
		.map((candidate) => candidate.rawScore)
		.filter(
			(score): score is number =>
				typeof score === "number" && Number.isFinite(score),
		);
	const bestVectorScore =
		vectorScores.length > 0
			? Math.max(...vectorScores)
			: Number.NEGATIVE_INFINITY;
	if (bestVectorScore < thresholds.vectorMinSimilarity)
		reasons.push("low_vector_similarity");

	if (thresholds.languageMismatch === true) reasons.push("language_mismatch");

	return { confident: reasons.length === 0, reasons };
}
