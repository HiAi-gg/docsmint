import { describe, expect, it } from "bun:test";
import { JOB_IDS, PIPELINE_SCHEMA_VERSION, prepareJobSchema } from "../../src/queue/contracts";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000002";
const GENERATION_ID = "00000000-0000-4000-8000-000000000003";

function migrateLegacyJob(raw: string) {
	const parsed = JSON.parse(raw) as { documentId?: string; id?: string } | string;
	const documentId = typeof parsed === "string" ? parsed : parsed.documentId ?? parsed.id;
	if (!documentId) throw new Error("legacy job has no document id");
	return prepareJobSchema.parse({
		schemaVersion: PIPELINE_SCHEMA_VERSION,
		stage: "prepare",
		documentId,
		ownerId: OWNER_ID,
		generationId: GENERATION_ID,
		revision: "legacy-revision",
		requestedAt: "2026-07-12T00:00:00.000Z",
		source: "backfill",
	});
}

describe("legacy embedding queue migration", () => {
	it("converts string and retry-envelope jobs to one prepare contract", () => {
		const jobs = [migrateLegacyJob(JSON.stringify(DOCUMENT_ID)), migrateLegacyJob(JSON.stringify({ id: DOCUMENT_ID }))];
		expect(jobs.every((job) => job.stage === "prepare")).toBe(true);
		expect(new Set(jobs.map((job) => JOB_IDS.prepare(job.documentId, job.generationId))).size).toBe(1);
	});

	it("uses deterministic prepare IDs for restart-safe deduplication", () => {
		expect(JOB_IDS.prepare(DOCUMENT_ID, GENERATION_ID)).toBe(
			`prepare-${DOCUMENT_ID}-${GENERATION_ID}`,
		);
	});
});
