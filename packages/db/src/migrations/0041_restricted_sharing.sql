DO $$ BEGIN
  CREATE TYPE "share_access_mode" AS ENUM ('public', 'restricted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "share_grant_status" AS ENUM ('pending', 'accepted', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "access_mode" "share_access_mode" NOT NULL DEFAULT 'public';--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "allow_password_fallback" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "policy_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "guest_access" ADD COLUMN IF NOT EXISTS "role" "share_role" NOT NULL DEFAULT 'viewer';--> statement-breakpoint
ALTER TABLE "guest_access" ADD COLUMN IF NOT EXISTS "status" "share_grant_status" NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "guest_access" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "guest_access" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;--> statement-breakpoint
UPDATE "guest_access" SET "guest_email" = lower(trim("guest_email"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "guest_access_share_link_email_unique_idx" ON "guest_access" ("share_link_id", "guest_email");--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_public_viewer_only_check";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_public_viewer_only_check" CHECK ("access_mode" = 'restricted' OR "role" = 'viewer');--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_password_fallback_check";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_password_fallback_check" CHECK (NOT "allow_password_fallback" OR ("access_mode" = 'restricted' AND "password_hash" IS NOT NULL));
