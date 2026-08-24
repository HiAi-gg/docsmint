export type { DocsClientConfig } from "./client.js";
export {
	DocsApiError,
	DocsClient,
	DocsNetworkError,
	DocsTimeoutError,
} from "./client.js";
export type {
	AssertPurgeAllowed,
	ExportUserDataContext,
	LifecycleHostStep,
	LifecycleOperationKind,
	LifecycleOperationStatus,
	PurgeUserDataContext,
	PurgeUserDataResult,
	UserDataExportRecord,
	UserDataLifecycle,
	UserDataLifecycleAdapter,
} from "./lifecycle.js";
export {
	configureUserDataLifecycle,
	createUserDataLifecycle,
	encodeUserDataExportNdjson,
	exportUserData,
	purgeUserData,
} from "./lifecycle.js";
export type * from "./types.js";
export type {
	DocsmintWorkspaceContext,
	WorkspaceAssertionOptions,
	WorkspaceAssertionPayload,
	WorkspaceResourcePermission,
	WorkspaceResourceScope,
	WorkspaceRole,
} from "./workspace.js";
export {
	createDocsmintWorkspaceAssertion,
	DOCSMINT_WORKSPACE_ASSERTION_CLOCK_SKEW_SECONDS,
	DOCSMINT_WORKSPACE_ASSERTION_TTL_SECONDS,
	DOCSMINT_WORKSPACE_CONTEXT_HEADER,
	verifyDocsmintWorkspaceAssertion,
} from "./workspace.js";
