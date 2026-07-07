/**
 * Pure S3 (SeaweedFS) factory — no module-eval side effects.
 *
 * This module MUST NOT import `./config` (which calls `envSchema.parse` and
 * `process.exit(1)` at import time). External consumers (e.g. docsmint)
 * import this through the npm export `@hiai-gg/hiai-docs/backend/lib/storage`
 * to call `createObjectStorageClient(cfg)` with their own config; pulling
 * hiai-docs' env-validation into their process would crash it on the first
 * missing variable.
 *
 * The singletons that power hiai-docs' own runtime live in `./storage.ts`
 * and import this factory.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { logger } from "./logger";

export interface ObjectStorageConfig {
	endpoint: string;
	port: number;
	accessKey: string;
	secretKey: string;
	useSSL: boolean;
	region: string;
	forcePathStyle: boolean;
}

export function createObjectStorageClient(cfg: ObjectStorageConfig): S3Client {
	return new S3Client({
		endpoint: cfg.useSSL
			? `https://${cfg.endpoint}:${cfg.port}`
			: `http://${cfg.endpoint}:${cfg.port}`,
		region: cfg.region,
		credentials: {
			accessKeyId: cfg.accessKey,
			secretAccessKey: cfg.secretKey,
		},
		forcePathStyle: cfg.forcePathStyle,
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
}

export async function ensureBucket(
	client: S3Client,
	bucket: string,
): Promise<void> {
	const { HeadBucketCommand, CreateBucketCommand } = await import(
		"@aws-sdk/client-s3"
	);
	try {
		await client.send(new HeadBucketCommand({ Bucket: bucket }));
	} catch {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
		logger.info({ bucket }, "Created storage bucket");
	}
}
