import { describe, expect, test } from "bun:test";
import * as GenerationState from "../lib/graph/generation-state";

const {
	graphCompensationCyphers,
	graphOrphanCleanupCypher,
	graphReplacementCyphers,
} = GenerationState;

describe("generation-safe graph state", () => {
	test("replaces only one document's prior edges before stamping the new generation", () => {
		const statements = graphReplacementCyphers({
			documentId: "doc-1",
			generationId: "generation-2",
			revision: "revision-2",
			timestamp: "2026-08-16T00:00:00.000Z",
		});
		const cypher = statements.join("\n");
		expect(statements).toHaveLength(3);
		expect(cypher).not.toContain("OPTIONAL MATCH");
		expect(cypher).toContain('r.document_id = "doc-1"');
		expect(cypher).toContain('d.generation_id = "generation-2"');
		expect(cypher).toContain('d.revision = "revision-2"');
		expect(cypher).toContain("[legacy:MENTIONS]");
	});

	test("rejects a late writer after a newer generation becomes active", async () => {
		const runGenerationFencedGraphWrite = (
			GenerationState as typeof GenerationState & {
				runGenerationFencedGraphWrite?: (dependencies: {
					lockCurrentGeneration: () => Promise<boolean>;
					persist: () => Promise<void>;
				}) => Promise<void>;
			}
		).runGenerationFencedGraphWrite;
		expect(typeof runGenerationFencedGraphWrite).toBe("function");
		const activeGeneration: string = "generation-2";
		const persisted: string[] = [];
		await expect(
			runGenerationFencedGraphWrite?.({
				lockCurrentGeneration: async () => activeGeneration === "generation-1",
				persist: async () => {
					persisted.push("generation-1");
				},
			}),
		).rejects.toHaveProperty("name", "stale_revision");
		expect(persisted).toEqual([]);
		await runGenerationFencedGraphWrite?.({
			lockCurrentGeneration: async () => activeGeneration === "generation-2",
			persist: async () => {
				persisted.push(activeGeneration);
			},
		});
		expect(persisted).toEqual(["generation-2"]);
	});

	test("cancellation compensates only the matching document generation", () => {
		const statements = graphCompensationCyphers("doc-1", "generation-2");
		const cypher = statements.join("\n");
		expect(statements).toHaveLength(2);
		expect(cypher).not.toContain("OPTIONAL MATCH");
		expect(cypher).toContain('r.document_id = "doc-1"');
		expect(cypher).toContain('r.generation_id = "generation-2"');
		expect(cypher).toContain('d.generation_id = "generation-2"');
	});

	test("full rebuild cleanup removes only disconnected entity vertices", () => {
		const cypher = graphOrphanCleanupCypher();
		expect(cypher).toContain("NOT (entity)--()");
		expect(cypher).toContain("NOT entity:Document");
	});

	test("upgrade cleanup removes propertyless legacy edges before orphan vertices", () => {
		const graphLegacyEdgeCleanupCypher = (
			GenerationState as typeof GenerationState & {
				graphLegacyEdgeCleanupCypher?: () => string;
			}
		).graphLegacyEdgeCleanupCypher;
		expect(typeof graphLegacyEdgeCleanupCypher).toBe("function");
		const cypher = graphLegacyEdgeCleanupCypher?.() ?? "";
		expect(cypher).toContain("edge.document_id IS NULL");
		expect(cypher).toContain("edge.generation_id IS NULL");
	});
});
