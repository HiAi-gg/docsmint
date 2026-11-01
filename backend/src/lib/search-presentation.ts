import type { SearchDiagnostics } from "../search/orchestrator";

const channels = new Set([
	"exact",
	"fts",
	"fuzzy",
	"vector",
	"expanded_fts",
	"expanded_fuzzy",
	"expanded_vector",
	"graph",
]);
const reasons = new Set([
	"no_lexical_match",
	"low_channel_agreement",
	"low_vector_similarity",
	"language_mismatch",
	"empty_candidates",
]);
function safeModel(value: string | undefined) {
	return value &&
		value.length <= 256 &&
		/^[a-zA-Z0-9_.:/-]+$/.test(value) &&
		!value.includes("://")
		? value
		: undefined;
}
/** Project only documented public diagnostics; adapter errors never become raw public text. */
export function publicSearchDiagnostics(value: SearchDiagnostics) {
	return {
		...(value.reason === "no_relevant_candidates"
			? { reason: value.reason }
			: {}),
		fastChannels: value.fastChannels.filter((channel) => channels.has(channel)),
		channelErrors: Object.fromEntries(
			Object.entries(value.channelErrors)
				.filter(([channel]) => channels.has(channel))
				.map(([channel, code]) => [
					channel,
					/^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "channel_failed",
				]),
		),
		expansionAttempted: value.expansionAttempted,
		expansionUsed: value.expansionUsed,
		...(safeModel(value.expansionModel)
			? { expansionModel: safeModel(value.expansionModel) }
			: {}),
		crossLanguageSuccess: value.crossLanguageSuccess,
		graphAttempted: value.graphAttempted,
		graphFailed: value.graphFailed,
		graphContribution: value.graphContribution,
		confidenceReasons: value.confidenceReasons.filter((reason) =>
			reasons.has(reason),
		),
		rerankAttempted: value.rerankAttempted,
		rerankUsed: value.rerankUsed,
		rerankFallback: value.rerankFallback,
		...(safeModel(value.rerankModel)
			? { rerankModel: safeModel(value.rerankModel) }
			: {}),
	};
}
