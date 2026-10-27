import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { encryptApiKey } from '../llm/crypto.service.js';
import { requireAuth, requireRoles } from '../auth/auth.middleware.js';
import { authService } from '../auth/auth.service.js';
import { emailMonitorService } from './email-monitor.service.js';

export const emailRouter = Router();

emailRouter.use(requireAuth);

const SaveEmailAccountSchema = z.object({
  id: z.coerce.number().int().positive().optional(),
  nombre: z.string().min(2).max(180).default('Buzón de Licitaciones'),
  email_address: z.string().email('Ingresa un correo electrónico válido.').max(180),
  imap_host: z.string().min(3, 'Ingresa el servidor IMAP (ej. imap.gmail.com).').max(180),
  imap_port: z.coerce.number().int().min(1).max(65535).default(993),
  imap_tls: z.boolean().default(true),
  imap_user: z.string().min(2, 'Ingresa el usuario de la cuenta de correo.').max(180),
  imap_password: z.string().optional(),
  mailbox: z.string().min(1).max(100).default('INBOX'),
  filtro_keywords: z.string().max(1000).optional().default(''),
  usar_lightpanda_links: z.boolean().default(true),
  frecuencia_horas: z.coerce.number().int().min(1).max(168).default(24),
  activo: z.boolean().default(true),
});

function sanitizeEmailAccount(row: any) {
  const { imap_password_encrypted, ...rest } = row;
  return {
    ...rest,
    has_password: Boolean(imap_password_encrypted && imap_password_encrypted.length > 0),
  };
}

/**
 * GET /api/email-accounts
 * Obtiene la configuración de "Correo E" del cliente activo y la bitácora de correos procesados.
 */
emailRouter.get('/', async (req, res) => {
  try {
    const tenantId = req.auth?.activeTenantId || 1;

    const accRes = await db.query(
      'SELECT * FROM email_accounts WHERE tenant_id = $1 ORDER BY id ASC LIMIT 1',
      [tenantId]
    );

    const account = accRes.rows[0] ? sanitizeEmailAccount(accRes.rows[0]) : null;

    const logsRes = await db.query(
      `SELECT
        m.*,
        t.titulo AS tender_titulo
       FROM email_messages_log m
       LEFT JOIN tenders t ON t.id = m.tender_id
       WHERE m.tenant_id = $1
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [tenantId]
    );

    res.json({
      ok: true,
      account,
      logs: logsRes.rows,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al cargar la configuración de Correo E.',
    });
  }
});

/**
 * POST /api/email-accounts/save
 * Guarda o actualiza la cuenta de correo monitoreada del cliente activo.
 */
emailRouter.post('/save', requireRoles(['superadmin', 'admin']), async (req, res) => {
  try {
    const auth = req.auth!;
    const tenantId = auth.activeTenantId || 1;

    const parsed = SaveEmailAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        message: parsed.error.issues[0]?.message || 'Parámetros de correo inválidos.',
      });
      return;
    }

    const d = parsed.data;
    const existingRes = await db.query(
      'SELECT * FROM email_accounts WHERE tenant_id = $1 ORDER BY id ASC LIMIT 1',
      [tenantId]
    );

    let encryptedPwd: string | null =
      existingRes.rows[0]?.imap_password_encrypted || null;

    if (d.imap_password && d.imap_password.trim().length > 0 && !d.imap_password.includes('•')) {
      encryptedPwd = encryptApiKey(d.imap_password.trim()).encrypted;
    }

    let savedRow: any;
    if ((existingRes.rowCount ?? 0) === 0) {
      const ins = await db.query(
        `INSERT INTO email_accounts (
          tenant_id, nombre, email_address, imap_host, imap_port, imap_tls,
          imap_user, imap_password_encrypted, mailbox, filtro_keywords,
          usar_lightpanda_links, frecuencia_horas, activo, proxima_revision_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13,
          CASE WHEN $13 = TRUE THEN NOW() ELSE NULL END
        ) RETURNING *`,
        [
          tenantId,
          d.nombre.trim(),
          d.email_address.trim().toLowerCase(),
          d.imap_host.trim(),
          d.imap_port,
          d.imap_tls,
          d.imap_user.trim(),
          encryptedPwd,
          d.mailbox.trim() || 'INBOX',
          d.filtro_keywords.trim(),
          d.usar_lightpanda_links,
          d.frecuencia_horas,
          d.activo,
        ]
      );
      savedRow = ins.rows[0];
    } else {
      const accountId = existingRes.rows[0].id;
      const upd = await db.query(
        `UPDATE email_accounts SET
          nombre = $1,
          email_address = $2,
          imap_host = $3,
          imap_port = $4,
          imap_tls = $5,
          imap_user = $6,
          imap_password_encrypted = $7,
          mailbox = $8,
          filtro_keywords = $9,
          usar_lightpanda_links = $10,
          frecuencia_horas = $11,
          activo = $12,
          proxima_revision_at = CASE
            WHEN $12 = TRUE AND proxima_revision_at IS NULL THEN NOW()
            ELSE proxima_revision_at
          END,
          updated_at = NOW()
         WHERE id = $13
         RETURNING *`,
        [
          d.nombre.trim(),
          d.email_address.trim().toLowerCase(),
          d.imap_host.trim(),
          d.imap_port,
          d.imap_tls,
          d.imap_user.trim(),
          encryptedPwd,
          d.mailbox.trim() || 'INBOX',
          d.filtro_keywords.trim(),
          d.usar_lightpanda_links,
          d.frecuencia_horas,
          d.activo,
          accountId,
        ]
      );
      savedRow = upd.rows[0];
    }

    await authService.logActivity({
      tenantId,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Configuración de cuenta Correo E',
      modulo: 'Configuración > Correo E',
      detalle: `Guardó buzón ${savedRow.email_address} (${savedRow.imap_host}:${savedRow.imap_port}, Activo: ${savedRow.activo})`,
    });

    res.json({
      ok: true,
      account: sanitizeEmailAccount(savedRow),
      message: 'Configuración de Correo E guardada correctamente.',
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al guardar la cuenta de correo.',
    });
  }
});

/**
 * POST /api/email-accounts/test
 * Prueba la conexión IMAP con los parámetros proporcionados o guardados.
 */
emailRouter.post('/test', requireRoles(['superadmin', 'admin']), async (req, res) => {
  try {
    const tenantId = req.auth?.activeTenantId || 1;
    const existingRes = await db.query(
      'SELECT id FROM email_accounts WHERE tenant_id = $1 ORDER BY id ASC LIMIT 1',
      [tenantId]
    );
    const existingId = existingRes.rows[0]?.id;

    const result = await emailMonitorService.testConnection({
      imap_host: String(req.body?.imap_host || ''),
      imap_port: Number(req.body?.imap_port || 993),
      imap_tls: req.body?.imap_tls !== false,
      imap_user: String(req.body?.imap_user || ''),
      imap_password: req.body?.imap_password ? String(req.body.imap_password) : undefined,
      existing_account_id: existingId,
      mailbox: String(req.body?.mailbox || 'INBOX'),
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      message: err?.message || 'Error al probar la conexión IMAP.',
    });
  }
});

/**
 * POST /api/email-accounts/sync-now
 * Ejecuta inmediatamente la lectura de correos nuevos y extracción hacia Licitaciones.
 */
emailRouter.post('/sync-now', requireRoles(['superadmin', 'admin']), async (req, res) => {
  try {
    const auth = req.auth!;
    const tenantId = auth.activeTenantId || 1;

    const accRes = await db.query(
      'SELECT id, email_address FROM email_accounts WHERE tenant_id = $1 ORDER BY id ASC LIMIT 1',
      [tenantId]
    );
    if ((accRes.rowCount ?? 0) === 0) {
      res.status(404).json({
        ok: false,
        message: 'Primero guarda la configuración de la cuenta de correo antes de sincronizar.',
      });
      return;
    }

    const account = accRes.rows[0];
    const result = await emailMonitorService.syncAccountById(account.id);

    await authService.logActivity({
      tenantId,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Sincronización manual de Correo E',
      modulo: 'Configuración > Correo E',
      detalle: `${account.email_address}: ${result.message}`,
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al sincronizar el buzón de correo.',
    });
  }
});
