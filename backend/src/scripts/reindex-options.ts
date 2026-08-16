export interface ReindexOptions {
	after?: string;
	batch: number;
	dryRun: boolean;
	all: boolean;
}

export function parseReindexOptions(argv: readonly string[]): ReindexOptions {
	const after = argv
		.find((arg) => arg.startsWith("--after="))
		?.slice("--after=".length);
	const batchValue = argv
		.find((arg) => arg.startsWith("--batch="))
		?.slice("--batch=".length);
	const batch = Number(batchValue ?? 100);
	return {
		after: after && after.length > 0 ? after : undefined,
		batch: Number.isFinite(batch) && batch > 0 ? Math.floor(batch) : 100,
		dryRun: argv.includes("--dry-run"),
		all: argv.includes("--all"),
	};
}
