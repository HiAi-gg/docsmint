export type { DocsClientConfig } from "./client.js";
export {
	DocsApiError,
	DocsClient,
	DocsNetworkError,
	DocsTimeoutError,
} from "./client.js";
export type * from "./types.js";
export {
	configureUserDataLifecycle,
	createUserDataLifecycle,
	encodeUserDataExportNdjson,
	exportUserData,
	purgeUserData,
} from "./lifecycle.js";
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
	createDocsmintWorkspaceAssertion,
	verifyDocsmintWorkspaceAssertion,
	DOCSMINT_WORKSPACE_CONTEXT_HEADER,
} from "./workspace.js";
export type { DocsmintWorkspaceContext, WorkspaceAssertionOptions } from "./workspace.js";
