-- audit_log is append-only: authenticated actors may record their own
-- events, while only an admin tenant context may read the audit trail.
-- No UPDATE or DELETE policy is intentionally defined.
DROP POLICY IF EXISTS tenant_isolation ON public.audit_log;--> statement-breakpoint
DROP POLICY IF EXISTS audit_insert ON public.audit_log;--> statement-breakpoint
DROP POLICY IF EXISTS audit_admin_select ON public.audit_log;--> statement-breakpoint

CREATE POLICY audit_insert ON public.audit_log
  FOR INSERT
  WITH CHECK (
    actor_id = current_setting('app.current_user_id', true)::uuid
    OR current_setting('app.current_user_role', true) = 'admin'
  );--> statement-breakpoint

CREATE POLICY audit_admin_select ON public.audit_log
  FOR SELECT
  USING (current_setting('app.current_user_role', true) = 'admin');--> statement-breakpoint

ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
