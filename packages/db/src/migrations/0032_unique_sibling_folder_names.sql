-- Normalize legacy duplicate sibling names before enforcing the invariant.
-- A folder's sibling scope is its parent when nested, otherwise its category
-- (including the uncategorized root scope).
DO $$
DECLARE
  duplicate_row RECORD;
  sequence_number integer;
  candidate_name text;
BEGIN
  FOR duplicate_row IN
    SELECT id, owner_id, parent_id, category_id, name
    FROM (
      SELECT f.*,
        row_number() OVER (
          PARTITION BY
            owner_id,
            parent_id,
            CASE WHEN parent_id IS NULL THEN category_id ELSE NULL END,
            name
          ORDER BY created_at, id
        ) AS duplicate_number
      FROM public.folders AS f
    ) AS ranked
    WHERE duplicate_number > 1
    ORDER BY created_at, id
  LOOP
    sequence_number := 2;
    LOOP
      candidate_name := left(
        duplicate_row.name,
        255 - length(' ' || sequence_number::text)
      ) || ' ' || sequence_number::text;

      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM public.folders AS sibling
        WHERE sibling.owner_id = duplicate_row.owner_id
          AND sibling.parent_id IS NOT DISTINCT FROM duplicate_row.parent_id
          AND (
            duplicate_row.parent_id IS NOT NULL
            OR sibling.category_id IS NOT DISTINCT FROM duplicate_row.category_id
          )
          AND sibling.name = candidate_name
      );
      sequence_number := sequence_number + 1;
    END LOOP;

    UPDATE public.folders
    SET name = candidate_name, updated_at = now()
    WHERE id = duplicate_row.id;
  END LOOP;
END
$$;
