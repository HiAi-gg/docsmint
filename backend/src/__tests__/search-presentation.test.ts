import { expect, test } from "bun:test";
import { publicSearchDiagnostics } from "../lib/search-presentation";

test("public diagnostics retain codes without arbitrary adapter or endpoint data", () => {
	const result = publicSearchDiagnostics({
		fastChannels: ["vector", "http://internal.invalid"],
		channelErrors: {
			vector: "fetch failed https://internal.invalid secret",
			fts: "query_failed",
			private: "private_failed",
		},
		expansionAttempted: true,
		expansionModel: "https://internal.invalid/model",
		graphAttempted: true,
		graphFailed: false,
		graphContribution: false,
		confidenceReasons: ["empty_candidates", "private-reason"],
		rerankAttempted: false,
		rerankUsed: false,
		rerankFallback: false,
		rerankModel: "provider/public-model",
	});
	expect(result.fastChannels).toEqual(["vector"]);
	expect(result.channelErrors).toEqual({
		vector: "channel_failed",
		fts: "query_failed",
	});
	expect(result.confidenceReasons).toEqual(["empty_candidates"]);
	expect(result.expansionModel).toBeUndefined();
	expect(result.rerankModel).toBe("provider/public-model");
});
