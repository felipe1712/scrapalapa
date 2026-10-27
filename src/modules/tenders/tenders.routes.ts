import fs from 'node:fs';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { tenderIngestionService } from './tender-ingestion.service.js';
import { claudeService } from '../llm/claude.service.js';
import { TaskNameSchema } from '../llm/llm.schemas.js';
import { authService } from '../auth/auth.service.js';

export const tendersRouter = Router();

const IngestUrlSchema = z.object({
  url: z.string().trim().url('Ingresa una URL válida (http:// o https://)'),
  keywords: z.string().trim().optional().default(''),
  ocr_mode: z.enum(['auto', 'forzar_surya']).optional().default('auto'),
  process_attachments: z.boolean().optional().default(true),
  max_attachments: z.coerce.number().int().min(1).max(20).optional().default(8),
  auth_username: z.string().trim().optional(),
  auth_password: z.string().optional(),
  auth_login_url: z.string().trim().optional(),
});

/**
 * GET /api/tenders
 * Lista el historial de licitaciones procesadas (incluyendo si son nuevas y la fuente de origen).
 */
tendersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth?.activeTenantId || 1;
    const result = await db.query(
      `SELECT
         t.id, t.source_url, t.titulo, t.entidad, t.numero_expediente,
         t.presupuesto_estimado, t.moneda, t.fecha_limite, t.nivel_riesgo,
         t.estado, t.metodo_navegacion, t.modelo_utilizado,
         t.tokens_utilizados, t.costo_estimado, t.latencia_total_ms,
         t.keywords_buscadas, t.hits_encontrados,
         t.source_id, t.es_nueva, t.origen_tipo, t.email_account_id,
         COALESCE(s.nombre, CASE WHEN t.origen_tipo = 'email' THEN '📧 ' || COALESCE(ea.nombre, 'Correo E') ELSE NULL END) AS source_nombre,
         t.created_at,
         (SELECT COUNT(*)::int FROM tender_documents d WHERE d.tender_id = t.id) AS total_documentos
       FROM tenders t
       LEFT JOIN scraping_sources s ON s.id = t.source_id
       LEFT JOIN email_accounts ea ON ea.id = t.email_account_id
       WHERE COALESCE(t.tenant_id, 1) = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [tenantId]
    );

    const newCount = result.rows.filter((r) => Boolean(r.es_nueva)).length;

    res.json({
      ok: true,
      new_count: newCount,
      latest_id: result.rows[0]?.id || 0,
      tenders: result.rows,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al consultar el listado de licitaciones.',
    });
  }
});

/**
 * GET /api/tenders/documents/:docId/download
 * Permite abrir en el visor in-situ o descargar el archivo PDF/Word traído por el scraper.
 */
tendersRouter.get('/documents/:docId/download', async (req: Request, res: Response) => {
  const docId = Number(req.params.docId);
  if (Number.isNaN(docId)) {
    res.status(400).json({ ok: false, message: 'ID de documento inválido' });
    return;
  }

  try {
    const docRes = await db.query(
      'SELECT file_name, file_type, local_path FROM tender_documents WHERE id = $1 LIMIT 1',
      [docId]
    );
    if (docRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Documento no encontrado' });
      return;
    }

    const doc = docRes.rows[0];
    if (!doc.local_path || !fs.existsSync(doc.local_path)) {
      res.status(404).json({ ok: false, message: 'El archivo físico ya no se encuentra en el servidor.' });
      return;
    }

    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
    };

    const contentType = mimeMap[doc.file_type] || 'application/octet-stream';
    const forceAttachment = req.query.download === '1';
    const dispositionType = !forceAttachment && doc.file_type === 'pdf' ? 'inline' : 'attachment';

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader(
      'Content-Disposition',
      `${dispositionType}; filename="${encodeURIComponent(doc.file_name)}"`
    );

    const stream = fs.createReadStream(doc.local_path);
    stream.pipe(res);
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al descargar el documento.',
    });
  }
});

/**
 * GET /api/tenders/:id
 * Obtiene el detalle completo de una licitación y marca es_nueva = false al abrirla.
 */
tendersRouter.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ ok: false, message: 'ID inválido' });
    return;
  }

  try {
    const tenderRes = await db.query('SELECT * FROM tenders WHERE id = $1 LIMIT 1', [id]);
    if (tenderRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Licitación no encontrada' });
      return;
    }

    if (req.query.seen === '1') {
      await db.query('UPDATE tenders SET es_nueva = false WHERE id = $1', [id]);
    }

    const docsRes = await db.query(
      'SELECT id, file_name, source_url, file_type, file_size_bytes, metodo_extraccion, paginas_procesadas, texto_extraido, created_at FROM tender_documents WHERE tender_id = $1 ORDER BY id ASC',
      [id]
    );

    res.json({
      ok: true,
      tender: tenderRes.rows[0],
      documents: docsRes.rows,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al obtener detalle de licitación.',
    });
  }
});

/**
 * POST /api/tenders/ingest-url
 * Ejecuta el pipeline de ingesta desde el formulario manual.
 */
tendersRouter.post('/ingest-url', async (req: Request, res: Response) => {
  const parsed = IngestUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      message: parsed.error.issues.map((i) => i.message).join('; '),
    });
    return;
  }

  try {
    const d = parsed.data;
    const tenantId = req.auth?.activeTenantId || 1;
    const result = await tenderIngestionService.ingestFromUrl({
      url: d.url,
      keywords: d.keywords,
      ocrMode: d.ocr_mode,
      processAttachments: d.process_attachments,
      maxAttachments: d.max_attachments,
      authUsername: d.auth_username,
      authPassword: d.auth_password,
      authLoginUrl: d.auth_login_url,
      skipIfDuplicate: false,
      tenantId,
      origenTipo: 'url',
    });

    if (req.auth) {
      await authService.logActivity({
        tenantId,
        userId: req.auth.userId,
        userEmail: req.auth.email,
        userNombre: req.auth.nombreCompleto,
        userRole: req.auth.role,
        accion: 'Extracción manual de licitación por URL',
        modulo: 'Licitaciones & Pipeline',
        detalle: `URL: ${d.url} (Keywords: "${d.keywords || 'ninguna'}")`,
      });
    }

    res.json(result);
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      message: err?.message || 'Error al procesar la URL de la licitación.',
    });
  }
});

/**
 * POST /api/tenders/:id/analyze
 * Ejecuta cualquiera de los perfiles de Claude sobre una licitación ya extraída.
 */
tendersRouter.post('/:id/analyze', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsedTask = TaskNameSchema.safeParse(req.body?.tarea || 'analisis');
  if (Number.isNaN(id) || !parsedTask.success) {
    res.status(400).json({ ok: false, message: 'Parámetros inválidos' });
    return;
  }

  try {
    const tenderRes = await db.query('SELECT * FROM tenders WHERE id = $1 LIMIT 1', [id]);
    if (tenderRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Licitación no encontrada' });
      return;
    }

    const t = tenderRes.rows[0];
    const combinedText = [t.contenido_pagina_texto, t.texto_documentos_ocr].filter(Boolean).join('\n\n');

    const result = await claudeService.generateTaskText({
      tarea: parsedTask.data,
      userPrompt: combinedText || t.titulo || t.source_url,
      tenderId: `TND-${id}`,
    });

    if (result.ok && result.data) {
      await db.query(
        `UPDATE tenders SET
          sintesis_claude = $1,
          modelo_utilizado = $2,
          tokens_utilizados = tokens_utilizados + $3,
          costo_estimado = costo_estimado + $4,
          updated_at = NOW()
         WHERE id = $5`,
        [
          result.data,
          result.model,
          result.usage.inputTokens + result.usage.outputTokens,
          result.usage.estimatedCostUsd,
          id,
        ]
      );
    }

    res.json({
      ok: true,
      result,
    });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      message: err?.message || 'Error al analizar licitación con Claude.',
    });
  }
});

/**
 * POST /api/tenders/:id/mark-seen
 */
tendersRouter.post('/:id/mark-seen', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isNaN(id)) {
    await db.query('UPDATE tenders SET es_nueva = false WHERE id = $1', [id]);
  }
  res.json({ ok: true });
});

/**
 * DELETE /api/tenders/:id
 */
tendersRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ ok: false, message: 'ID inválido' });
    return;
  }
  await db.query('DELETE FROM tenders WHERE id = $1', [id]);
  res.json({ ok: true });
});
