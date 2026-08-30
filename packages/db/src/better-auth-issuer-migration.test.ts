import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('./migrations/0047_better_auth_17_account_identity.sql', import.meta.url),
  'utf8'
);

test('Better Auth issuer migration preserves one-version rollback account writes', () => {
  expect(migration).toContain('CREATE OR REPLACE FUNCTION public.accounts_fill_legacy_issuer()');
  expect(migration).toContain('IF NEW.issuer IS NULL THEN');
  expect(migration).toContain('BEFORE INSERT OR UPDATE OF provider_id, issuer');
  expect(migration).toContain('ALTER TABLE public.accounts ALTER COLUMN issuer SET NOT NULL');
});
