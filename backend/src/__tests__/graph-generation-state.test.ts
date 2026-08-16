import { describe, expect, test } from "bun:test";
import {
	graphCompensationCypher,
	graphOrphanCleanupCypher,
	graphReplacementPreludeCypher,
} from "../lib/graph/generation-state";

describe("generation-safe graph state", () => {
	test("replaces only one document's prior edges before stamping the new generation", () => {
		const cypher = graphReplacementPreludeCypher({
			documentId: "doc-1",
			generationId: "generation-2",
			revision: "revision-2",
			timestamp: "2026-08-16T00:00:00.000Z",
		});
		expect(cypher).toContain('r.document_id = "doc-1"');
		expect(cypher).toContain('d.generation_id = "generation-2"');
		expect(cypher).toContain('d.revision = "revision-2"');
	});

	test("cancellation compensates only the matching document generation", () => {
		const cypher = graphCompensationCypher("doc-1", "generation-2");
		expect(cypher).toContain('r.document_id = "doc-1"');
		expect(cypher).toContain('r.generation_id = "generation-2"');
		expect(cypher).toContain('d.generation_id = "generation-2"');
	});

	test("full rebuild cleanup removes only disconnected entity vertices", () => {
		const cypher = graphOrphanCleanupCypher();
		expect(cypher).toContain("NOT (entity)--()");
		expect(cypher).toContain("NOT entity:Document");
	});
});
