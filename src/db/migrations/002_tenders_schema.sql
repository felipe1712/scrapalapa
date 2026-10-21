-- ============================================================================
-- Migración 002: Tablas de Licitaciones e Ingesta de Documentos (Lightpanda + Surya + Claude)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenders (
    id SERIAL PRIMARY KEY,
    source_url TEXT NOT NULL,
    titulo VARCHAR(300),
    entidad VARCHAR(255),
    numero_expediente VARCHAR(150),
    presupuesto_estimado NUMERIC(15, 2),
    moneda VARCHAR(20) DEFAULT 'MXN',
    fecha_limite VARCHAR(80),
    nivel_riesgo VARCHAR(30),
    estado VARCHAR(40) NOT NULL DEFAULT 'procesando' CHECK (estado IN ('procesando', 'completado', 'error')),
    metodo_navegacion VARCHAR(80),
    contenido_pagina_texto TEXT,
    texto_documentos_ocr TEXT,
    extraccion_reglas_locales JSONB NOT NULL DEFAULT '{}'::jsonb,
    campos_extraidos_json JSONB,
    sintesis_claude TEXT,
    modelo_utilizado VARCHAR(120),
    tokens_utilizados INTEGER NOT NULL DEFAULT 0,
    costo_estimado NUMERIC(12, 6) NOT NULL DEFAULT 0,
    latencia_total_ms INTEGER NOT NULL DEFAULT 0,
    error_detalle TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenders_created_at ON tenders (created_at DESC);

CREATE TABLE IF NOT EXISTS tender_documents (
    id SERIAL PRIMARY KEY,
    tender_id INTEGER NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    source_url TEXT NOT NULL,
    file_type VARCHAR(40) NOT NULL, -- 'pdf' | 'docx' | 'doc' | 'html'
    file_size_bytes BIGINT NOT NULL DEFAULT 0,
    local_path TEXT,
    metodo_extraccion VARCHAR(80) NOT NULL, -- 'surya_ocr' | 'surya_hybrid_pdf' | 'word_mammoth' | 'lightpanda_dom'
    paginas_procesadas INTEGER NOT NULL DEFAULT 1,
    texto_extraido TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tender_documents_tender_id ON tender_documents (tender_id);
