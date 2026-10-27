-- ============================================================================
-- MIGRACIÓN 005: ARQUITECTURA MULTITENANT, AUTENTICACIÓN POR CORREO,
-- BITÁCORA DE ACTIVIDAD Y MONITOREO AUTOMÁTICO DE CORREO ("CORREO E")
-- ============================================================================

-- 1. Tabla de Clientes (Tenants) con Datos Fiscales, Dirección y 2 Contactos
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    nombre_comercial VARCHAR(200) NOT NULL,
    razon_social VARCHAR(250) NOT NULL DEFAULT '',
    rfc VARCHAR(25) NOT NULL DEFAULT '',
    regimen_fiscal VARCHAR(120) NOT NULL DEFAULT '',
    uso_cfdi VARCHAR(120) NOT NULL DEFAULT '',
    email_facturacion VARCHAR(180) NOT NULL DEFAULT '',
    -- Dirección Fiscal / Comercial
    calle VARCHAR(200) NOT NULL DEFAULT '',
    numero_exterior VARCHAR(50) NOT NULL DEFAULT '',
    numero_interior VARCHAR(50) NOT NULL DEFAULT '',
    colonia VARCHAR(150) NOT NULL DEFAULT '',
    codigo_postal VARCHAR(20) NOT NULL DEFAULT '',
    municipio_alcaldia VARCHAR(150) NOT NULL DEFAULT '',
    ciudad VARCHAR(150) NOT NULL DEFAULT '',
    estado VARCHAR(120) NOT NULL DEFAULT '',
    pais VARCHAR(100) NOT NULL DEFAULT 'México',
    -- Contacto Administrativo
    contacto_admin_nombre VARCHAR(180) NOT NULL DEFAULT '',
    contacto_admin_cargo VARCHAR(120) NOT NULL DEFAULT '',
    contacto_admin_email VARCHAR(180) NOT NULL DEFAULT '',
    contacto_admin_telefono VARCHAR(60) NOT NULL DEFAULT '',
    -- Contacto Técnico
    contacto_tecnico_nombre VARCHAR(180) NOT NULL DEFAULT '',
    contacto_tecnico_cargo VARCHAR(120) NOT NULL DEFAULT '',
    contacto_tecnico_email VARCHAR(180) NOT NULL DEFAULT '',
    contacto_tecnico_telefono VARCHAR(60) NOT NULL DEFAULT '',
    -- Estado y control
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    notas TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Semilla de Cliente Principal (Tenant #1) para preservar todos los datos actuales
INSERT INTO tenants (
    id, nombre_comercial, razon_social, rfc, regimen_fiscal, uso_cfdi, email_facturacion,
    ciudad, estado, pais,
    contacto_admin_nombre, contacto_admin_cargo, contacto_admin_email,
    contacto_tecnico_nombre, contacto_tecnico_cargo, contacto_tecnico_email,
    activo
)
SELECT
    1,
    'CAUSER — Organización Principal',
    'CAUSER S.A. de C.V.',
    'CAU010101AAA',
    '601 - General de Ley Personas Morales',
    'G03 - Gastos en general',
    'admin@causer.com.mx',
    'Ciudad de México',
    'CDMX',
    'México',
    'Administrador General',
    'Dirección Administrativa',
    'admin@causer.com.mx',
    'Soporte Técnico',
    'Dirección de Tecnología',
    'admin@causer.com.mx',
    TRUE
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = 1);

SELECT setval(pg_get_serial_sequence('tenants', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM tenants), 1));

-- 2. Tabla de Usuarios (Anclados al correo electrónico)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(180) NOT NULL UNIQUE,
    nombre_completo VARCHAR(180) NOT NULL,
    cargo VARCHAR(120) NOT NULL DEFAULT '',
    telefono VARCHAR(60) NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'analista', -- 'superadmin' | 'admin' | 'analista'
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    ultimo_acceso_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 3. Tabla de Sesiones Activas
CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    active_tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ip_address VARCHAR(80),
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);

-- 4. Tabla de Bitácora de Actividad (Auditoría por Cliente y Usuario)
CREATE TABLE IF NOT EXISTS activity_logs (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email VARCHAR(180) NOT NULL DEFAULT '',
    user_nombre VARCHAR(180) NOT NULL DEFAULT '',
    user_role VARCHAR(30) NOT NULL DEFAULT '',
    accion VARCHAR(120) NOT NULL,
    modulo VARCHAR(80) NOT NULL,
    detalle TEXT NOT NULL DEFAULT '',
    ip_address VARCHAR(80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_created ON activity_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created ON activity_logs(user_id, created_at DESC);

-- 5. Tabla de Cuentas de Correo Monitoreadas ("Correo E")
CREATE TABLE IF NOT EXISTS email_accounts (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    nombre VARCHAR(180) NOT NULL DEFAULT 'Buzón de Licitaciones',
    email_address VARCHAR(180) NOT NULL,
    imap_host VARCHAR(180) NOT NULL,
    imap_port INTEGER NOT NULL DEFAULT 993,
    imap_tls BOOLEAN NOT NULL DEFAULT TRUE,
    imap_user VARCHAR(180) NOT NULL,
    imap_password_encrypted TEXT,
    mailbox VARCHAR(100) NOT NULL DEFAULT 'INBOX',
    filtro_keywords TEXT NOT NULL DEFAULT 'licitacion, licitación, convocatoria, mantenimiento, desarrollo, adquisicion, adquisición, bases, concurso',
    usar_lightpanda_links BOOLEAN NOT NULL DEFAULT TRUE,
    frecuencia_horas INTEGER NOT NULL DEFAULT 24,
    activo BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen_uid INTEGER NOT NULL DEFAULT 0,
    ultima_revision_at TIMESTAMPTZ,
    proxima_revision_at TIMESTAMPTZ,
    ultimo_resultado VARCHAR(32) NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'running' | 'success' | 'error'
    ultimo_mensaje TEXT,
    total_correos_procesados INTEGER NOT NULL DEFAULT 0,
    total_licitaciones_encontradas INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_tenant_id ON email_accounts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_activo_proxima ON email_accounts(activo, proxima_revision_at);

-- 6. Historial de Correos Procesados ("Correo E")
CREATE TABLE IF NOT EXISTS email_messages_log (
    id SERIAL PRIMARY KEY,
    email_account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    message_id VARCHAR(255) NOT NULL,
    uid INTEGER NOT NULL DEFAULT 0,
    subject TEXT NOT NULL DEFAULT '',
    from_address VARCHAR(255) NOT NULL DEFAULT '',
    received_at TIMESTAMPTZ,
    attachments_count INTEGER NOT NULL DEFAULT 0,
    links_scraped_count INTEGER NOT NULL DEFAULT 0,
    tender_id INTEGER REFERENCES tenders(id) ON DELETE SET NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'processed', -- 'processed' | 'duplicate' | 'skipped' | 'error'
    detalle TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_messages_account_id ON email_messages_log(email_account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_unique_msg ON email_messages_log(email_account_id, message_id);

-- 7. Agregar soporte Multitenant y origen de correo a tablas existentes
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE DEFAULT 1;
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS origen_tipo VARCHAR(30) NOT NULL DEFAULT 'url'; -- 'url' | 'source' | 'email'
ALTER TABLE tenders ADD COLUMN IF NOT EXISTS email_account_id INTEGER REFERENCES email_accounts(id) ON DELETE SET NULL;

UPDATE tenders SET tenant_id = 1 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenders_tenant_id ON tenders(tenant_id, created_at DESC);

ALTER TABLE scraping_sources ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE DEFAULT 1;
UPDATE scraping_sources SET tenant_id = 1 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_scraping_sources_tenant_id ON scraping_sources(tenant_id);

ALTER TABLE scraping_runs ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE DEFAULT 1;
UPDATE scraping_runs SET tenant_id = 1 WHERE tenant_id IS NULL;
