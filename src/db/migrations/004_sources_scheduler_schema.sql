-- ============================================================================
-- Migración 004: Fuentes de Interés, Bitácora del Agente/Scheduler y Deduplicación
-- ============================================================================

CREATE TABLE IF NOT EXISTS scraping_sources (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(200) NOT NULL,
    entidad VARCHAR(200),
    url TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT 'mantenimiento, desarrollo, adquisición',
    frecuencia_horas INTEGER NOT NULL DEFAULT 24 CHECK (frecuencia_horas >= 1 AND frecuencia_horas <= 720),
    activo BOOLEAN NOT NULL DEFAULT true,
    requiere_auth BOOLEAN NOT NULL DEFAULT false,
    auth_username VARCHAR(200),
    auth_password_encrypted TEXT,
    auth_password_masked VARCHAR(30),
    auth_login_url TEXT,
    ultima_revision_at TIMESTAMPTZ,
    proxima_revision_at TIMESTAMPTZ DEFAULT NOW(),
    ultimo_estado VARCHAR(30) NOT NULL DEFAULT 'pendiente' CHECK (ultimo_estado IN ('pendiente', 'ejecutando', 'exito', 'error')),
    ultimo_mensaje TEXT,
    total_licitaciones_encontradas INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraping_sources_schedule
  ON scraping_sources (activo, proxima_revision_at);

CREATE TABLE IF NOT EXISTS scraping_runs (
    id SERIAL PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES scraping_sources(id) ON DELETE CASCADE,
    disparo VARCHAR(20) NOT NULL DEFAULT 'programado' CHECK (disparo IN ('programado', 'manual')),
    estado VARCHAR(20) NOT NULL DEFAULT 'ejecutando' CHECK (estado IN ('ejecutando', 'exito', 'error')),
    hits_detectados INTEGER NOT NULL DEFAULT 0,
    licitaciones_nuevas INTEGER NOT NULL DEFAULT 0,
    licitaciones_duplicadas INTEGER NOT NULL DEFAULT 0,
    duracion_ms INTEGER NOT NULL DEFAULT 0,
    mensaje_log TEXT,
    error_detalle TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraping_runs_source_created
  ON scraping_runs (source_id, created_at DESC);

ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES scraping_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dedup_hash VARCHAR(64),
  ADD COLUMN IF NOT EXISTS es_nueva BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenders_dedup_hash
  ON tenders (dedup_hash)
  WHERE dedup_hash IS NOT NULL;

-- ============================================================================
-- Seed inicial de 8 Fuentes de Interés de ejemplo (solo si la tabla está vacía)
-- ============================================================================
INSERT INTO scraping_sources (nombre, entidad, url, keywords, frecuencia_horas, activo, proxima_revision_at)
SELECT * FROM (VALUES
  (
    'Poder Judicial CDMX — Licitaciones Públicas',
    'Poder Judicial de la Ciudad de México',
    'https://poderjudicialcdmx.gob.mx/licitaciones/',
    'mantenimiento, desarrollo, adquisición, soporte',
    24,
    true,
    NOW() + INTERVAL '10 minutes'
  ),
  (
    'Tianguis Digital CDMX — Convocatorias Abiertas',
    'Gobierno de la Ciudad de México',
    'https://tianguisdigital.cdmx.gob.mx/',
    'mantenimiento, desarrollo, software, adquisición',
    24,
    true,
    NOW() + INTERVAL '20 minutes'
  ),
  (
    'UNAM — Dirección General de Proveeduría',
    'Universidad Nacional Autónoma de México',
    'https://www.proveeduria.unam.mx/',
    'mantenimiento, desarrollo, adquisición, cómputo',
    24,
    true,
    NOW() + INTERVAL '30 minutes'
  ),
  (
    'INE — Licitaciones y Contrataciones Públicas',
    'Instituto Nacional Electoral',
    'https://www.ine.mx/licitaciones/',
    'mantenimiento, desarrollo, adquisición, tecnología',
    24,
    true,
    NOW() + INTERVAL '40 minutes'
  ),
  (
    'Banco de México — Licitaciones y Contrataciones',
    'Banco de México (BANXICO)',
    'https://www.banxico.org.mx/servicios/licitaciones-contrataciones-b.html',
    'mantenimiento, desarrollo, adquisición, sistemas',
    24,
    true,
    NOW() + INTERVAL '50 minutes'
  ),
  (
    'CFE — Micrositio de Concursos y Licitaciones',
    'Comisión Federal de Electricidad',
    'https://msc.cfe.mx/Aplicaciones/NCFE/Concursos/',
    'mantenimiento, adquisición, sistemas, eléctrico',
    24,
    false,
    NOW() + INTERVAL '24 hours'
  ),
  (
    'IMSS — Portal de Compras y Adquisiciones',
    'Instituto Mexicano del Seguro Social',
    'https://compras.imss.gob.mx/',
    'mantenimiento, adquisición, equipamiento, médico',
    24,
    false,
    NOW() + INTERVAL '24 hours'
  ),
  (
    'CJF — Licitaciones Consejo de la Judicatura',
    'Consejo de la Judicatura Federal',
    'https://www.cjf.gob.mx/resources/index/infoRelevante/2025/licitaciones.htm',
    'mantenimiento, adquisición, soporte, infraestructura',
    48,
    false,
    NOW() + INTERVAL '48 hours'
  )
) AS v(nombre, entidad, url, keywords, frecuencia_horas, activo, proxima_revision_at)
WHERE NOT EXISTS (SELECT 1 FROM scraping_sources LIMIT 1);
