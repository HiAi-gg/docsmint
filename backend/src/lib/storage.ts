/**
 * hiai-docs' own S3 (SeaweedFS) singletons.
 *
 * External consumers should NOT import this module — it pulls in
 * `./config` and crashes the process if any required env var is missing.
 * Use the npm export `@hiai-gg/hiai-docs/backend/lib/storage` instead,
 * which resolves to `./storage-factory.ts` (pure, side-effect-free).
 */
import { config } from "./config";
import { createObjectStorageClient } from "./storage-factory";

export type { ObjectStorageConfig } from "./storage-factory";
export { createObjectStorageClient, ensureBucket } from "./storage-factory";

const internalConfig = {
	endpoint: config.STORAGE_ENDPOINT,
	port: config.STORAGE_PORT,
	accessKey: config.STORAGE_ACCESS_KEY,
	secretKey: config.STORAGE_SECRET_KEY,
	useSSL: false,
	region: config.STORAGE_REGION,
	forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
};

const publicConfig = {
	endpoint: config.STORAGE_PUBLIC_ENDPOINT,
	port: config.STORAGE_PUBLIC_PORT,
	accessKey: config.STORAGE_ACCESS_KEY,
	secretKey: config.STORAGE_SECRET_KEY,
	useSSL: false,
	region: config.STORAGE_REGION,
	forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
};

if (!config.STORAGE_ENDPOINT) throw new Error("STORAGE_ENDPOINT is required");
if (!config.STORAGE_PUBLIC_ENDPOINT)
	throw new Error("STORAGE_PUBLIC_ENDPOINT is required");

export const storage = createObjectStorageClient(internalConfig);
export const storagePublic = createObjectStorageClient(publicConfig);
export const BUCKET = config.STORAGE_BUCKET;
