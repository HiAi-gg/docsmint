-- Better Auth 1.7.3+ returns to (provider_id, account_id) identity.
-- Preserve explicit issuers and the 0047 trigger/index for rollback compatibility.
-- No accounts or identity values are rewritten or removed.
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS id_token text;
ALTER TABLE public.accounts ALTER COLUMN issuer DROP NOT NULL;
