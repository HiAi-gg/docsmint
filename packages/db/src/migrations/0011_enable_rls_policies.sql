-- Enable RLS on tenant-scoped tables (idempotent — safe to re-run after
-- `drizzle-kit push` reconciliation drops policies). DO blocks guard
-- against errors when objects already exist.
DO $$ BEGIN
  ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.document_tags ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.document_embeddings ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.versions ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.guest_access ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint

-- RLS policies for tables WITH owner_id (unified FOR ALL policy).
-- Drop-and-recreate so this migration is idempotent after push drops them.
DROP POLICY IF EXISTS tenant_isolation ON public.folders;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.folders FOR ALL
  USING (owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  WITH CHECK (owner_id = current_setting('app.current_user_id', true)::uuid
              OR current_setting('app.current_user_role', true) = 'admin');--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.documents;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.documents FOR ALL
  USING (owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  WITH CHECK (owner_id = current_setting('app.current_user_id', true)::uuid
              OR current_setting('app.current_user_role', true) = 'admin');--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.tags;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tags FOR ALL
  USING (owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  WITH CHECK (owner_id = current_setting('app.current_user_id', true)::uuid
              OR current_setting('app.current_user_role', true) = 'admin');--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.categories;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.categories FOR ALL
  USING (owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  WITH CHECK (owner_id = current_setting('app.current_user_id', true)::uuid
              OR current_setting('app.current_user_role', true) = 'admin');--> statement-breakpoint

-- RLS policies for tables WITHOUT owner_id (join through parent documents table)
DROP POLICY IF EXISTS tenant_isolation ON public.attachments;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.attachments FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.attachments.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.attachments.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ));--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.versions;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.versions FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.versions.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.versions.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ));--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.document_tags;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.document_tags FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.document_tags.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.document_tags.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ));--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON public.document_embeddings;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.document_embeddings FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.document_embeddings.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.documents
    WHERE public.documents.id = public.document_embeddings.document_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ));--> statement-breakpoint

-- share_links has created_by (owner) and document_id/folder_id
DROP POLICY IF EXISTS tenant_isolation ON public.share_links;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.share_links FOR ALL
  USING (
    created_by = current_setting('app.current_user_id', true)::uuid
    OR current_setting('app.current_user_role', true) = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.documents
      WHERE public.documents.id = public.share_links.document_id
      AND public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    created_by = current_setting('app.current_user_id', true)::uuid
    OR current_setting('app.current_user_role', true) = 'admin'
  );--> statement-breakpoint

-- guest_access joins through share_links -> documents
DROP POLICY IF EXISTS tenant_isolation ON public.guest_access;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.guest_access FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.share_links
    JOIN public.documents ON public.documents.id = public.share_links.document_id
    WHERE public.share_links.id = public.guest_access.share_link_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.share_links
    JOIN public.documents ON public.documents.id = public.share_links.document_id
    WHERE public.share_links.id = public.guest_access.share_link_id
    AND (public.documents.owner_id = current_setting('app.current_user_id', true)::uuid
         OR current_setting('app.current_user_role', true) = 'admin')
  ));--> statement-breakpoint

-- FORCE ROW LEVEL SECURITY for all application roles
-- Even table owner (aiuser) must respect RLS. Idempotent — `FORCE` is
-- safe to re-run on a table that already has it set.
ALTER TABLE public.folders FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.categories FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_tags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.document_embeddings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.attachments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.share_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.guest_access FORCE ROW LEVEL SECURITY;