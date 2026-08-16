export interface GraphGenerationIdentity {
	documentId: string;
	generationId: string;
	revision: string;
	timestamp: string;
}

function literal(value: string): string {
	return JSON.stringify(value);
}

/** Atomically remove one document's prior graph projection and stamp its replacement. */
export function graphReplacementPreludeCypher(
	identity: GraphGenerationIdentity,
): string {
	const documentId = literal(identity.documentId);
	const generationId = literal(identity.generationId);
	const revision = literal(identity.revision);
	const timestamp = literal(identity.timestamp);
	return `
		OPTIONAL MATCH ()-[r]->()
		WHERE r.document_id = ${documentId}
		DELETE r
		WITH count(r) AS removed
		MERGE (d:Document {id: ${documentId}})
		SET d.generation_id = ${generationId}, d.revision = ${revision},
			d.created_at = coalesce(d.created_at, ${timestamp}),
			d.entity_extracted_at = ${timestamp}
		RETURN d.id
	`;
}

/** Remove only graph state written by the cancelled generation. */
export function graphCompensationCypher(
	documentIdValue: string,
	generationIdValue: string,
): string {
	const documentId = literal(documentIdValue);
	const generationId = literal(generationIdValue);
	return `
		MATCH (d:Document {id: ${documentId}})
		OPTIONAL MATCH ()-[r]->()
		WHERE r.document_id = ${documentId}
		  AND r.generation_id = ${generationId}
		DELETE r
		WITH d
		WHERE d.generation_id = ${generationId}
		DETACH DELETE d
		RETURN 1
	`;
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
