import { Client } from "minio";
import { config } from "./config";

export const minio = new Client({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: false,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
});

export const BUCKET = config.MINIO_BUCKET;
