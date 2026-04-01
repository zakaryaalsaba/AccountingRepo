-- Extend document sequences with optional branch/department dimensions

ALTER TABLE document_sequences
  ADD COLUMN IF NOT EXISTS branch_dimension_id UUID REFERENCES dimensions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_dimension_id UUID REFERENCES dimensions (id) ON DELETE SET NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'document_sequences'
      AND constraint_name = 'document_sequences_company_id_doc_type_fiscal_year_id_key'
  ) THEN
    ALTER TABLE document_sequences
      DROP CONSTRAINT document_sequences_company_id_doc_type_fiscal_year_id_key;
  END IF;
END$$;

DROP INDEX IF EXISTS uq_document_sequences_company_doc_default;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'document_sequences'
      AND constraint_name = 'uq_document_sequences_scope'
  ) THEN
    ALTER TABLE document_sequences
      ADD CONSTRAINT uq_document_sequences_scope
      UNIQUE NULLS NOT DISTINCT (
        company_id,
        doc_type,
        fiscal_year_id,
        branch_dimension_id,
        department_dimension_id
      );
  END IF;
END$$;

CREATE OR REPLACE FUNCTION next_document_number(
  p_company_id UUID,
  p_doc_type TEXT,
  p_fiscal_year_id UUID DEFAULT NULL,
  p_branch_dimension_id UUID DEFAULT NULL,
  p_department_dimension_id UUID DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  seq_row document_sequences%ROWTYPE;
  n BIGINT;
BEGIN
  SELECT *
  INTO seq_row
  FROM document_sequences
  WHERE company_id = p_company_id
    AND doc_type = p_doc_type
    AND (
      (p_fiscal_year_id IS NULL AND fiscal_year_id IS NULL) OR fiscal_year_id = p_fiscal_year_id
    )
    AND (
      (p_branch_dimension_id IS NULL AND branch_dimension_id IS NULL) OR branch_dimension_id = p_branch_dimension_id
    )
    AND (
      (p_department_dimension_id IS NULL AND department_dimension_id IS NULL) OR department_dimension_id = p_department_dimension_id
    )
    AND is_active = TRUE
  ORDER BY updated_at DESC
  LIMIT 1
  FOR UPDATE;

  IF seq_row.id IS NULL THEN
    RAISE EXCEPTION 'No active sequence configured for doc_type % with given scope', p_doc_type;
  END IF;

  n := seq_row.last_number + 1;

  UPDATE document_sequences
  SET last_number = n,
      updated_at = NOW()
  WHERE id = seq_row.id;

  RETURN COALESCE(seq_row.prefix, '')
    || lpad(n::text, seq_row.padding, '0')
    || COALESCE(seq_row.suffix, '');
END;
$$ LANGUAGE plpgsql;
