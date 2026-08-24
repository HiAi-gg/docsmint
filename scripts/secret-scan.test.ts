import { expect, test } from "bun:test";

import { findSecretCandidates } from "./secret-scan.ts";

test("secret scanning rejects known credential shapes without reporting their values", () => {
	const accessKey = `AKIA${"A".repeat(16)}`;
	const findings = findSecretCandidates([
		{ path: "src/config.ts", source: `export const credential = "${accessKey}";` },
	]);

	expect(findings).toEqual([
		{ path: "src/config.ts", detector: "AWS access key" },
	]);
	expect(JSON.stringify(findings)).not.toContain(accessKey);
});

test("secret scanning accepts placeholders and ordinary source", () => {
	expect(
		findSecretCandidates([
			{ path: ".env.example", source: "OPENROUTER_API_KEY=your-key-here" },
			{ path: "src/config.ts", source: "const mode = 'development';" },
		]),
	).toEqual([]);
});
