export interface KnowledgeSummaryDocument {
	title: string;
	content: string;
	revision: string;
}

export interface KnowledgeSummaryProviderResult {
	language: string;
	description: string;
	keywords: string[];
	model: string;
}

export type KnowledgeSummaryResult =
	| { status: "skipped"; reason: "empty_document" }
	| ({ status: "ready" } & KnowledgeSummaryProviderResult);

export async function buildKnowledgeSummary(
	document: KnowledgeSummaryDocument,
	provider: (
		document: KnowledgeSummaryDocument,
	) => Promise<KnowledgeSummaryProviderResult | null>,
): Promise<KnowledgeSummaryResult> {
	if (!document.content.trim()) {
		return { status: "skipped", reason: "empty_document" };
	}
	const output = await provider(document);
	if (!output) throw new Error("summary_provider_failed");
	const language = output.language.trim();
	const description = output.description.trim();
	if (!language || !description) throw new Error("summary_provider_invalid");
	const seen = new Set<string>();
	const keywords: string[] = [];
	for (const raw of output.keywords) {
		const keyword = raw.trim();
		const key = keyword.toLocaleLowerCase("en");
		if (!keyword || seen.has(key)) continue;
		seen.add(key);
		keywords.push(keyword);
		if (keywords.length === 20) break;
	}
	return {
		status: "ready",
		language,
		description,
		keywords,
		model: output.model,
	};
}
