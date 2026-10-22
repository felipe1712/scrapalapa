import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { encryptApiKey } from '../llm/crypto.service.js';
import { sourcesSchedulerService } from './scheduler.service.js';

export const sourcesRouter = Router();

const UpsertSourceSchema = z.object({
  nombre: z.string().trim().min(2, 'El nombre de la fuente es obligatorio').max(200),
  entidad: z.string().trim().max(200).optional().nullable(),
  url: z.string().trim().url('Ingresa una URL válida (http:// o https://)'),
  keywords: z.string().trim().min(2, 'Ingresa al menos una palabra clave'),
  frecuencia_horas: z.coerce.number().int().min(1).max(720).default(24),
  activo: z.boolean().default(true),
  requiere_auth: z.boolean().default(false),
  auth_username: z.string().trim().max(200).optional().nullable(),
  auth_password: z.string().optional().nullable(),
  clear_password: z.boolean().optional().default(false),
  auth_login_url: z.string().trim().optional().nullable(),
});

function sanitizeSourceRow(row: any) {
  return {
    id: row.id,
    nombre: row.nombre,
    entidad: row.entidad,
    url: row.url,
    keywords: row.keywords,
    frecuencia_horas: row.frecuencia_horas,
    activo: row.activo,
    requiere_auth: row.requiere_auth,
    auth_username: row.auth_username || '',
    has_password: Boolean(row.auth_password_encrypted),
    auth_password_masked: row.auth_password_masked || null,
    auth_login_url: row.auth_login_url || '',
    ultima_revision_at: row.ultima_revision_at,
    proxima_revision_at: row.proxima_revision_at,
    ultimo_estado: row.ultimo_estado,
    ultimo_mensaje: row.ultimo_mensaje,
    total_licitaciones_encontradas: row.total_licitaciones_encontradas,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * GET /api/sources
 * Lista todas las fuentes de interés y las últimas ejecuciones del agente.
 */
sourcesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const sourcesRes = await db.query(
      `SELECT * FROM scraping_sources ORDER BY id ASC`
    );
    const runsRes = await db.query(
      `SELECT r.*, s.nombre AS source_nombre, s.url AS source_url
       FROM scraping_runs r
       JOIN scraping_sources s ON s.id = r.source_id
       ORDER BY r.created_at DESC
       LIMIT 40`
    );

    res.json({
      ok: true,
      sources: sourcesRes.rows.map(sanitizeSourceRow),
      runs: runsRes.rows,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al consultar las fuentes de interés.',
    });
  }
});

/**
 * POST /api/sources
 * Alta de una nueva fuente de interés.
 */
sourcesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = UpsertSourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: parsed.error.issues.map((i) => i.message).join('; '),
    });
    return;
  }

  const d = parsed.data;
  let encryptedPass: string | null = null;
  let maskedPass: string | null = null;

  if (d.requiere_auth && d.auth_password && d.auth_password.trim().length > 0) {
    const enc = encryptApiKey(d.auth_password.trim());
    encryptedPass = enc.encrypted;
    maskedPass = `••••${enc.last4}`;
  }

  try {
    const insertRes = await db.query(
      `INSERT INTO scraping_sources (
        nombre, entidad, url, keywords, frecuencia_horas, activo,
        requiere_auth, auth_username, auth_password_encrypted, auth_password_masked, auth_login_url,
        proxima_revision_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() + ($5 || ' hours')::interval)
      RETURNING *`,
      [
        d.nombre,
        d.entidad || null,
        d.url,
        d.keywords,
        d.frecuencia_horas,
        d.activo,
        d.requiere_auth,
        d.requiere_auth ? d.auth_username || null : null,
        encryptedPass,
        maskedPass,
        d.requiere_auth && d.auth_login_url ? d.auth_login_url : null,
      ]
    );

    res.json({
      ok: true,
      message: 'Fuente de interés creada correctamente.',
      source: sanitizeSourceRow(insertRes.rows[0]),
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al guardar la fuente de interés.',
    });
  }
});

/**
 * PUT /api/sources/:id
 * Cambio / edición completa de una fuente de interés (incluyendo credenciales cifradas).
 */
sourcesRouter.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ ok: false, message: 'ID inválido' });
    return;
  }

  const parsed = UpsertSourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: parsed.error.issues.map((i) => i.message).join('; '),
    });
    return;
  }

  try {
    const existingRes = await db.query('SELECT * FROM scraping_sources WHERE id = $1 LIMIT 1', [id]);
    if (existingRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Fuente no encontrada.' });
      return;
    }

    const current = existingRes.rows[0];
    const d = parsed.data;

    let encryptedPass: string | null = current.auth_password_encrypted;
    let maskedPass: string | null = current.auth_password_masked;

    if (!d.requiere_auth || d.clear_password) {
      encryptedPass = null;
      maskedPass = null;
    } else if (d.auth_password && d.auth_password.trim().length > 0 && !d.auth_password.includes('••••')) {
      const enc = encryptApiKey(d.auth_password.trim());
      encryptedPass = enc.encrypted;
      maskedPass = `••••${enc.last4}`;
    }

    const updateRes = await db.query(
      `UPDATE scraping_sources SET
        nombre = $1,
        entidad = $2,
        url = $3,
        keywords = $4,
        frecuencia_horas = $5,
        activo = $6,
        requiere_auth = $7,
        auth_username = $8,
        auth_password_encrypted = $9,
        auth_password_masked = $10,
        auth_login_url = $11,
        updated_at = NOW()
       WHERE id = $12
       RETURNING *`,
      [
        d.nombre,
        d.entidad || null,
        d.url,
        d.keywords,
        d.frecuencia_horas,
        d.activo,
        d.requiere_auth,
        d.requiere_auth ? d.auth_username || null : null,
        encryptedPass,
        maskedPass,
        d.requiere_auth && d.auth_login_url ? d.auth_login_url : null,
        id,
      ]
    );

    res.json({
      ok: true,
      message: 'Fuente de interés actualizada correctamente.',
      source: sanitizeSourceRow(updateRes.rows[0]),
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al actualizar la fuente de interés.',
    });
  }
});

/**
 * PATCH /api/sources/:id/toggle
 * Activa o pausa rápidamente una fuente desde el interruptor de la tabla.
 */
sourcesRouter.patch('/:id/toggle', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const activo = Boolean(req.body?.activo);
  if (Number.isNaN(id)) {
    res.status(400).json({ ok: false, message: 'ID inválido' });
    return;
  }

  try {
    const upd = await db.query(
      `UPDATE scraping_sources
       SET activo = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [activo, id]
    );
    if (upd.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Fuente no encontrada.' });
      return;
    }

    res.json({
      ok: true,
      source: sanitizeSourceRow(upd.rows[0]),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al cambiar estado.' });
  }
});

/**
 * DELETE /api/sources/:id
 * Baja / eliminación de una fuente de interés.
 */
sourcesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ ok: false, message: 'ID inválido' });
    return;
  }

  try {
    await db.query('DELETE FROM scraping_sources WHERE id = $1', [id]);
    res.json({ ok: true, message: 'Fuente eliminada.' });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al eliminar la fuente.' });
  }
});

/**
 * POST /api/sources/:id/run-now
 * Ejecuta inmediatamente una fuente específica y devuelve el resultado.
 */
sourcesRouter.post('/:id/run-now', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ ok: false, message: 'ID inválido' });
    return;
  }

  try {
    const result = await sourcesSchedulerService.runSourceById(id, 'manual');
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al ejecutar la fuente.' });
  }
});

/**
 * POST /api/sources/run-all
 * Lanza la revisión de todas las fuentes activas en segundo plano.
 */
sourcesRouter.post('/run-all', async (_req: Request, res: Response) => {
  try {
    const result = await sourcesSchedulerService.runAllActiveSources();
    res.json({
      ok: true,
      started_count: result.startedCount,
      message: `Se inició la revisión de ${result.startedCount} fuente(s) activa(s) en segundo plano.`,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al iniciar revisión masiva.' });
  }
});
