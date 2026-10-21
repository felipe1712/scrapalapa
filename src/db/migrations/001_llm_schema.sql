-- ============================================================================
-- Fase 5c: Esquema de Configuración Persistente de la API de Claude (Anthropic)
-- ============================================================================

-- 1. Catálogo de modelos (llm_models)
CREATE TABLE IF NOT EXISTS llm_models (
    model_id VARCHAR(120) PRIMARY KEY,
    nombre_visible VARCHAR(160) NOT NULL,
    max_output_tokens INTEGER NOT NULL DEFAULT 8192,
    ventana_contexto INTEGER NOT NULL DEFAULT 200000,
    precio_entrada_mtok NUMERIC(10, 4) NOT NULL DEFAULT 3.0000,
    precio_salida_mtok NUMERIC(10, 4) NOT NULL DEFAULT 15.0000,
    disponible BOOLEAN NOT NULL DEFAULT true,
    personalizado_precios BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Configuración activa y versionada (llm_settings - fila única id=1)
CREATE TABLE IF NOT EXISTS llm_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    provider VARCHAR(40) NOT NULL DEFAULT 'anthropic',
    activo BOOLEAN NOT NULL DEFAULT false,
    version INTEGER NOT NULL DEFAULT 1,
    api_key_encrypted TEXT,
    api_key_last4 VARCHAR(8),
    api_base_url VARCHAR(255) NOT NULL DEFAULT 'https://api.anthropic.com',
    anthropic_version VARCHAR(40) NOT NULL DEFAULT '2023-06-01',
    default_model VARCHAR(120) NOT NULL,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    temperature NUMERIC(4, 2),
    top_p NUMERIC(4, 2),
    timeout_ms INTEGER NOT NULL DEFAULT 60000,
    max_retries INTEGER NOT NULL DEFAULT 3,
    max_input_chars INTEGER NOT NULL DEFAULT 120000,
    limite_tokens_diario BIGINT,
    limite_costo_mensual NUMERIC(12, 2),
    accion_limite VARCHAR(20) NOT NULL DEFAULT 'avisar' CHECK (accion_limite IN ('pausar', 'avisar')),
    created_by VARCHAR(100) NOT NULL DEFAULT 'system',
    updated_by VARCHAR(100) NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Perfiles por tarea (llm_task_profiles)
CREATE TABLE IF NOT EXISTS llm_task_profiles (
    tarea VARCHAR(50) PRIMARY KEY CHECK (
        tarea IN ('completar_campos', 'resumen_licitacion', 'analisis', 'constructor_recetas')
    ),
    nombre_tarea VARCHAR(100) NOT NULL,
    descripcion VARCHAR(255),
    model VARCHAR(120),
    max_tokens INTEGER,
    temperature NUMERIC(4, 2),
    system_prompt TEXT NOT NULL DEFAULT '',
    activo BOOLEAN NOT NULL DEFAULT true,
    updated_by VARCHAR(100) NOT NULL DEFAULT 'system',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Bitácora de consumo y llamadas (llm_usage)
CREATE TABLE IF NOT EXISTS llm_usage (
    id BIGSERIAL PRIMARY KEY,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tarea VARCHAR(50) NOT NULL,
    modelo VARCHAR(120) NOT NULL,
    tokens_entrada INTEGER NOT NULL DEFAULT 0,
    tokens_salida INTEGER NOT NULL DEFAULT 0,
    tokens_cache_creacion INTEGER NOT NULL DEFAULT 0,
    tokens_cache_lectura INTEGER NOT NULL DEFAULT 0,
    costo_estimado NUMERIC(12, 6) NOT NULL DEFAULT 0,
    latencia_ms INTEGER NOT NULL DEFAULT 0,
    exito BOOLEAN NOT NULL DEFAULT true,
    codigo_error VARCHAR(80),
    mensaje_error TEXT,
    tender_id VARCHAR(100),
    document_id VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_fecha ON llm_usage (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_tarea_fecha ON llm_usage (tarea, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_llm_usage_modelo_fecha ON llm_usage (modelo, fecha DESC);

-- 5. Historial de auditoría de cambios (llm_settings_history)
CREATE TABLE IF NOT EXISTS llm_settings_history (
    id BIGSERIAL PRIMARY KEY,
    fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    entidad VARCHAR(50) NOT NULL, -- 'llm_settings' | 'llm_task_profiles' | 'llm_models'
    accion VARCHAR(50) NOT NULL,  -- 'update' | 'replace_api_key' | 'delete_api_key' | 'sync_models' | 'seed'
    usuario VARCHAR(100) NOT NULL,
    version_resultante INTEGER,
    campos_modificados JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_llm_history_fecha ON llm_settings_history (fecha DESC);

-- 6. Trigger PostgreSQL para invalidación en tiempo real vía LISTEN/NOTIFY
CREATE OR REPLACE FUNCTION notify_llm_config_changed()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        'llm_config_changed',
        json_build_object(
            'table', TG_TABLE_NAME,
            'op', TG_OP,
            'timestamp', extract(epoch from now())
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_llm_settings_notify ON llm_settings;
CREATE TRIGGER trg_llm_settings_notify
AFTER INSERT OR UPDATE OR DELETE ON llm_settings
FOR EACH STATEMENT EXECUTE FUNCTION notify_llm_config_changed();

DROP TRIGGER IF EXISTS trg_llm_profiles_notify ON llm_task_profiles;
CREATE TRIGGER trg_llm_profiles_notify
AFTER INSERT OR UPDATE OR DELETE ON llm_task_profiles
FOR EACH STATEMENT EXECUTE FUNCTION notify_llm_config_changed();

DROP TRIGGER IF EXISTS trg_llm_models_notify ON llm_models;
CREATE TRIGGER trg_llm_models_notify
AFTER INSERT OR UPDATE OR DELETE ON llm_models
FOR EACH STATEMENT EXECUTE FUNCTION notify_llm_config_changed();
