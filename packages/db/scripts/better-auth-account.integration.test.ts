import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { requireIntegrationUrl } from "./integration-env";

const databaseUrl = requireIntegrationUrl("PIPELINE_RLS_TEST_DATABASE_URL");

describe("Better Auth account compatibility integration", () => {
  it("preserves legacy identities and accepts current account writes", async () => {
    const sql = postgres(databaseUrl, { max: 1 });
    const ownerId = crypto.randomUUID();
    const rollback = new Error("ROLLBACK_ACCOUNT_COMPATIBILITY_TEST");
    try {
      const columns = await sql`SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'accounts'
        AND column_name IN ('issuer', 'id_token') ORDER BY column_name`;
      expect(columns).toEqual([
        { column_name: "id_token", is_nullable: "YES" },
        { column_name: "issuer", is_nullable: "YES" },
      ]);
      await sql.begin(async (tx) => {
        await tx`INSERT INTO public.users (id, email)
          VALUES (${ownerId}::uuid, ${`${ownerId}@account-compat.invalid`})`;
        const [credential] = await tx`INSERT INTO public.accounts
          (user_id, account_id, provider_id, password)
          VALUES (${ownerId}::uuid, ${ownerId}, 'credential', 'synthetic')
          RETURNING issuer, id_token`;
        expect(credential).toEqual({ issuer: "local:credential", id_token: null });
        // Distinct providers may share the same external subject.
        for (const provider of ["test-provider-a", "test-provider-b"]) {
          const [account] = await tx`INSERT INTO public.accounts
            (user_id, account_id, provider_id, id_token)
            VALUES (${ownerId}::uuid, 'shared-subject', ${provider}, 'synthetic-token')
            RETURNING issuer, id_token`;
          expect(account).toEqual({
            issuer: `local:oauth:${Buffer.from(provider).toString("base64")}`,
            id_token: "synthetic-token",
          });
        }
        const [legacy] = await tx`INSERT INTO public.accounts
          (user_id, account_id, provider_id, issuer)
          VALUES (${ownerId}::uuid, 'legacy-subject', 'legacy-provider', 'https://legacy.invalid')
          RETURNING id, issuer`;
        expect(legacy?.issuer).toBe("https://legacy.invalid");
        const [updated] = await tx`UPDATE public.accounts SET id_token = 'updated-token'
          WHERE id = ${legacy!.id}::uuid RETURNING issuer, id_token`;
        expect(updated).toEqual({ issuer: "https://legacy.invalid", id_token: "updated-token" });
        await expect(tx.savepoint(async (sp) => {
          await sp`INSERT INTO public.accounts (user_id, account_id, provider_id)
            VALUES (${ownerId}::uuid, 'shared-subject', 'test-provider-a')`;
        })).rejects.toMatchObject({ code: "23505" });
        throw rollback;
      }).catch((error: unknown) => { if (error !== rollback) throw error; });
    } finally {
      await sql.end();
    }
  });
});
