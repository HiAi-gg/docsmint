export type SearchChannel =
	| "exact"
	| "fts"
	| "fuzzy"
	| "vector"
	| "expanded_fts"
	| "expanded_fuzzy"
	| "expanded_vector"
	| "graph";

export interface QueryPlan {
	original: string;
	normalized: string;
	detectedLanguage: string;
	translations: string[];
	synonyms: string[];
	concepts: string[];
	namedEntities: string[];
}

export interface SearchCandidate {
	documentId: string;
	channel: SearchChannel;
	rank: number;
	rawScore?: number;
	queryVariant?: string;
	evidence: string;
}

export type ExpansionReason =
	| "no_lexical_match"
	| "low_channel_agreement"
	| "low_vector_similarity"
	| "language_mismatch"
	| "empty_candidates";

export interface SearchExplanation {
	channel: SearchChannel;
	label: string;
	queryVariant?: string;
}

export interface ChannelResult {
	channel: SearchChannel;
	candidates: SearchCandidate[];
	durationMs: number;
	errorCode?: string;
}

export interface ConfidenceThresholds {
	vectorMinSimilarity: number;
	minChannelAgreement?: number;
	languageMismatch?: boolean;
}

export interface ConfidenceResult {
	confident: boolean;
	reasons: ExpansionReason[];
}

export interface RrfOptions {
	rrfK?: number;
	exactBoost?: number;
	channelAgreementBoost?: number;
	graphMaxContribution?: number;
	vectorMinSimilarity?: number;
}

export interface RankedSearchResult {
	documentId: string;
	score: number;
	channels: SearchChannel[];
	explanations: SearchExplanation[];
}

export type SearchSort =
	| "relevance"
	| "date_desc"
	| "date_asc"
	| "name_asc"
	| "name_desc";

export interface SearchFilters {
	folderId?: string;
	tagNames?: string[];
	categoryId?: string;
	dateFrom?: string;
	dateTo?: string;
	sort?: SearchSort;
}
