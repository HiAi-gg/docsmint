-- Better Auth 1.7 provider-id account identity migration.
-- The nullable phase and collision guard make an accidental ambiguous upgrade
-- fail before the new uniqueness contract is installed.
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS issuer text;

UPDATE public.accounts
SET issuer = CASE
  WHEN provider_id = 'credential' THEN 'local:credential'
  ELSE 'local:oauth:' || encode(convert_to(provider_id, 'UTF8'), 'base64')
END
WHERE issuer IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.accounts
    GROUP BY issuer, account_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Better Auth 1.7 migration aborted: duplicate (issuer, account_id) identities';
  END IF;
END
$$;

ALTER TABLE public.accounts ALTER COLUMN issuer SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_issuer_account_idx
  ON public.accounts (issuer, account_id);

-- Keep one-version rollback compatibility with Better Auth 1.6 hosts. That
-- runtime does not send issuer when it creates an account; the bridge derives
-- the same deterministic local issuer used by the backfill before NOT NULL is
-- checked. Better Auth 1.7 values remain authoritative when supplied.
CREATE OR REPLACE FUNCTION public.accounts_fill_legacy_issuer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.issuer IS NULL THEN
    NEW.issuer := CASE
      WHEN NEW.provider_id = 'credential' THEN 'local:credential'
      ELSE 'local:oauth:' || encode(convert_to(NEW.provider_id, 'UTF8'), 'base64')
    END;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS accounts_fill_legacy_issuer ON public.accounts;
CREATE TRIGGER accounts_fill_legacy_issuer
BEFORE INSERT OR UPDATE OF provider_id, issuer ON public.accounts
FOR EACH ROW
EXECUTE FUNCTION public.accounts_fill_legacy_issuer();
