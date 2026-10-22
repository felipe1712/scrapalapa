-- ============================================================================
-- Migración 003: Búsqueda por Palabras Clave y Hits en Lightpanda
-- ============================================================================

ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS keywords_buscadas TEXT,
  ADD COLUMN IF NOT EXISTS hits_encontrados JSONB NOT NULL DEFAULT '[]'::jsonb;
