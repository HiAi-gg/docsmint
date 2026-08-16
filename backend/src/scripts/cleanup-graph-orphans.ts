import {
	cleanupLegacyGraphEdges,
	cleanupOrphanGraphEntities,
} from "../lib/graph/delete-document-state";

export async function cleanupGraphOrphans() {
	await cleanupLegacyGraphEdges();
	await cleanupOrphanGraphEntities();
}

if (import.meta.main) {
	await cleanupGraphOrphans();
	console.log(JSON.stringify({ status: "complete" }));
}
