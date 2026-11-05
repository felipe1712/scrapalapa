-- ============================================================================
-- MIGRACIÓN 006: ESTRUCTURA JERÁRQUICA DOCUMENTO -> PROCEDIMIENTOS (DRILL-DOWN)
-- Y CRONOGRAMA DE FECHAS / HITOS (TIMELINE)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tender_procedures (
    id SERIAL PRIMARY KEY,
    tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE DEFAULT 1,
    numero_procedimiento VARCHAR(180) NOT NULL,
    titulo_objeto TEXT NOT NULL,
    entidad VARCHAR(250),
    alcance_periodo TEXT NOT NULL DEFAULT '',
    cronograma JSONB NOT NULL DEFAULT '[]'::jsonb,
    requisitos_clave JSONB NOT NULL DEFAULT '[]'::jsonb,
    sintesis_claude TEXT,
    estado VARCHAR(40) NOT NULL DEFAULT 'vigente', -- 'vigente' | 'proximo_a_vencer' | 'concluido'
    proximo_evento_nombre VARCHAR(180),
    proximo_evento_fecha DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tender_procedures_tender ON tender_procedures(tender_id, id);
CREATE INDEX IF NOT EXISTS idx_tender_procedures_tenant ON tender_procedures(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tender_procedures_num ON tender_procedures(numero_procedimiento);

-- Migrar retroactivamente licitaciones existentes en 'tenders' que no tengan procedimientos hijos
INSERT INTO tender_procedures (
    tender_id, tenant_id, numero_procedimiento, titulo_objeto, entidad,
    alcance_periodo, requisitos_clave, sintesis_claude, estado, created_at, updated_at
)
SELECT
    t.id,
    COALESCE(t.tenant_id, 1),
    COALESCE(NULLIF(t.numero_expediente, ''), 'PROC-' || t.id),
    COALESCE(NULLIF(t.titulo, ''), t.source_url),
    t.entidad,
    '',
    COALESCE(t.campos_extraidos_json->'requisitos_clave', '[]'::jsonb),
    t.sintesis_claude,
    'vigente',
    t.created_at,
    t.updated_at
FROM tenders t
WHERE NOT EXISTS (
    SELECT 1 FROM tender_procedures p WHERE p.tender_id = t.id
);
