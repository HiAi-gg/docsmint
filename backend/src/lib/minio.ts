import { Client } from "minio";
import { config } from "./config";
import { logger } from "./logger";

export interface MinioConfig {
	endpoint: string;
	port: number;
	accessKey: string;
	secretKey: string;
	useSSL: boolean;
	region: string;
}

export function createMinio(cfg: MinioConfig): Client {
	return new Client({
		endPoint: cfg.endpoint,
		port: cfg.port,
		useSSL: cfg.useSSL,
		accessKey: cfg.accessKey,
		secretKey: cfg.secretKey,
		region: cfg.region,
	});
}

export async function ensureBucket(
	client: Client,
	bucket: string,
): Promise<void> {
	const exists = await client.bucketExists(bucket);
	if (!exists) {
		await client.makeBucket(bucket, "us-east-1");
		logger.info({ bucket }, "Created MinIO bucket");
	}
}

// Backwards-compatible optional singletons:
const defaultMinioConfig: MinioConfig = {
	endpoint: config.MINIO_ENDPOINT,
	port: config.MINIO_PORT,
	accessKey: config.MINIO_ACCESS_KEY,
	secretKey: config.MINIO_SECRET_KEY,
	useSSL: false,
	region: "us-east-1",
};

const defaultMinioPublicConfig: MinioConfig = {
	endpoint: config.MINIO_PUBLIC_ENDPOINT,
	port: config.MINIO_PUBLIC_PORT,
	accessKey: config.MINIO_ACCESS_KEY,
	secretKey: config.MINIO_SECRET_KEY,
	useSSL: false,
	region: "us-east-1",
};

if (!config.MINIO_ENDPOINT) throw new Error("MINIO_ENDPOINT is required");
if (!config.MINIO_PUBLIC_ENDPOINT)
	throw new Error("MINIO_PUBLIC_ENDPOINT is required");

export const minio: Client = createMinio(defaultMinioConfig);
export const minioPublic: Client = createMinio(defaultMinioPublicConfig);

export const BUCKET = config.MINIO_BUCKET;
