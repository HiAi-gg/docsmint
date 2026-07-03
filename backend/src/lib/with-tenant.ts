// Thin re-export — tenant-scoped query logic now lives in @hiai-docs/db/with-tenant

export type { TenantContext } from "@hiai-docs/db/with-tenant";
export {
	adminTenantContext,
	shareGuestTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
