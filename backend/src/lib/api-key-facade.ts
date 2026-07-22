/**
 * Server-only credential lifecycle facade for product hosts.
 *
 * DocsMint OSS remains the sole owner of key generation, hashing, encrypted
 * category secrets, revocation, and verification. Downstream hosts may only
 * add their own target overlay after calling these functions.
 */
export {
	buildCategoryApiKeyScopes,
	createApiKey as issueApiKey,
	GLOBAL_API_SCOPE,
	listApiKeys,
	revealCategoryApiKey,
	revokeApiKey,
	validateApiKey as verifyApiKey,
} from "./api-keys";
