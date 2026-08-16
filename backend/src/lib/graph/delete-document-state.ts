import {
	graphCompensationCypher,
	graphOrphanCleanupCypher,
} from "./generation-state";
import { getGraphDb } from "./init";

/** Idempotently delete one document vertex and all of its graph edges. */
export async function deleteDocumentGraphState(
	documentId: string,
): Promise<void> {
	const sql = await getGraphDb();
	if (!sql) return;
	const literal = JSON.stringify(documentId);
	await sql.begin(async (tx) => {
		await tx.unsafe("SET LOCAL search_path = ag_catalog, public");
		await tx.unsafe(
			`SELECT * FROM cypher('docs_graph', $$ MATCH (d:Document {id: ${literal}}) DETACH DELETE d RETURN 1 $$) AS (deleted agtype)`,
		);
	});
}

/** Remove graph state only when it still belongs to the cancelled generation. */
export async function deleteDocumentGraphGeneration(
	documentId: string,
	generationId: string,
): Promise<void> {
	const sql = await getGraphDb();
	if (!sql) return;
	await sql.begin(async (tx) => {
		await tx.unsafe("SET LOCAL search_path = ag_catalog, public");
		await tx.unsafe(
			`SELECT * FROM cypher('docs_graph', $$ ${graphCompensationCypher(documentId, generationId)} $$) AS (deleted agtype)`,
		);
	});
}

/** Remove disconnected entity vertices after a completed full rebuild. */
export async function cleanupOrphanGraphEntities(): Promise<void> {
	const sql = await getGraphDb();
	if (!sql) return;
	await sql.begin(async (tx) => {
		await tx.unsafe("SET LOCAL search_path = ag_catalog, public");
		await tx.unsafe(
			`SELECT * FROM cypher('docs_graph', $$ ${graphOrphanCleanupCypher()} $$) AS (deleted agtype)`,
		);
	});
}
