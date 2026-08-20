export interface GraphGenerationIdentity {
	documentId: string;
	generationId: string;
	revision: string;
	timestamp: string;
}

function literal(value: string): string {
	return JSON.stringify(value);
}

export function isStaleRevisionError(error: unknown): boolean {
	return error instanceof Error && error.name === "stale_revision";
}

export async function runGenerationFencedGraphWrite(dependencies: {
	lockCurrentGeneration(): Promise<boolean>;
	persist(): Promise<void>;
}): Promise<void> {
	if (!(await dependencies.lockCurrentGeneration())) {
		const error = new Error("graph generation is stale");
		error.name = "stale_revision";
		throw error;
	}
	await dependencies.persist();
}

/** Atomically remove one document's prior graph projection and stamp its replacement. */
export function graphReplacementCyphers(
	identity: GraphGenerationIdentity,
): string[] {
	const documentId = literal(identity.documentId);
	const generationId = literal(identity.generationId);
	const revision = literal(identity.revision);
	const timestamp = literal(identity.timestamp);
	return [
		`MATCH (d:Document {id: ${documentId}})-[legacy:MENTIONS]->()
		 DELETE legacy RETURN count(legacy)`,
		`MATCH ()-[r]->() WHERE r.document_id = ${documentId}
		 DELETE r RETURN count(r)`,
		`MERGE (d:Document {id: ${documentId}})
		 SET d.generation_id = ${generationId}, d.revision = ${revision},
		     d.created_at = coalesce(d.created_at, ${timestamp}),
		     d.entity_extracted_at = ${timestamp}
		 RETURN d.id`,
	];
}

/** Remove propertyless edges once before a full post-upgrade graph rebuild. */
export function graphLegacyEdgeCleanupCypher(): string {
	return `
		MATCH ()-[edge]->()
		WHERE edge.document_id IS NULL OR edge.generation_id IS NULL
		DELETE edge
		RETURN count(edge)
	`;
}

/** Remove only graph state written by the cancelled generation. */
export function graphCompensationCyphers(
	documentIdValue: string,
	generationIdValue: string,
): string[] {
	const documentId = literal(documentIdValue);
	const generationId = literal(generationIdValue);
	return [
		`MATCH ()-[r]->()
		 WHERE r.document_id = ${documentId}
		   AND r.generation_id = ${generationId}
		 DELETE r RETURN count(r)`,
		`MATCH (d:Document {id: ${documentId}})
		 WHERE d.generation_id = ${generationId}
		 DETACH DELETE d RETURN count(d)`,
	];
}

/** Delete entity vertices left disconnected after a completed full rebuild. */
export function graphOrphanCleanupCypher(): string {
	return `
		MATCH (entity)
		WHERE NOT entity:Document AND NOT (entity)--()
		DELETE entity
		RETURN count(entity)
	`;
}
