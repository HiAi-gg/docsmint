-- Legacy 0.6.8 inserts omit uploaded_by. Personal rows inherit the parent
-- owner; workspace rows inherit the current request actor when present.
CREATE OR REPLACE FUNCTION public.fill_legacy_attachment_uploaded_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_owner_id uuid;
  parent_workspace_id text;
  current_actor_id uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF NEW.uploaded_by IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT parent.owner_id, parent.workspace_id
    INTO parent_owner_id, parent_workspace_id
  FROM public.documents AS parent
  WHERE parent.id = NEW.document_id
  FOR SHARE;
  IF parent_workspace_id IS NULL THEN
    NEW.uploaded_by := parent_owner_id;
  ELSE
    NEW.uploaded_by := COALESCE(current_actor_id, parent_owner_id);
  END IF;
  RETURN NEW;
END;
$$;
