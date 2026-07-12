-- Category-scoped API keys can be revealed again by their owner. The value is
-- AES-GCM encrypted by the API before storage; global and legacy keys remain
-- hash-only and keep this column NULL.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "encrypted_key" text;
