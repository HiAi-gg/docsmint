export type { Database } from "./client";
export { client, db } from "./client";
export type {
	CreateDocumentWithVersionInput,
	UpdateDocumentWithVersionInput,
} from "./document-writer";
export {
	createDocumentWithVersion,
	trashDocuments,
	updateDocumentWithVersion,
} from "./document-writer";
export * from "./schema";
export type {
	ActorScopedTransactionExecutor,
	TenantContext,
	TenantTransaction,
} from "./with-tenant";
export {
	adminTenantContext,
	createActorScopedTransactionExecutor,
	shareGuestTenantContext,
	withTenant,
} from "./with-tenant";
