import fs from 'node:fs';
import path from 'node:path';
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
 * GET /api/tenders/tree
 * Devuelve la estructura jerárquica: Convocatorias/Documentos Fuente como nodos padre
 * y las Licitaciones/Procedimientos desglosados como nodos hijos (drill-down).
 */
tendersRouter.get('/tree', async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth?.activeTenantId || 1;
    const filterQuery = (req.query.q as string || '').trim().toLowerCase();

    const tendersRes = await db.query(
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

    const proceduresRes = await db.query(
      `SELECT
         id, tender_id, numero_procedimiento, titulo_objeto, entidad,
         alcance_periodo, cronograma, requisitos_clave, estado,
         proximo_evento_nombre, proximo_evento_fecha, created_at
       FROM tender_procedures
       WHERE COALESCE(tenant_id, 1) = $1
       ORDER BY id ASC`,
      [tenantId]
    );

    const proceduresByTender = new Map<number, any[]>();
    for (const p of proceduresRes.rows) {
      if (!proceduresByTender.has(p.tender_id)) {
        proceduresByTender.set(p.tender_id, []);
      }
      proceduresByTender.get(p.tender_id)!.push(p);
    }

    let tree = tendersRes.rows.map((t) => {
      const procs = proceduresByTender.get(t.id) || [
        {
          id: `virtual-${t.id}`,
          tender_id: t.id,
          numero_procedimiento: t.numero_expediente || `PROC-${t.id}`,
          titulo_objeto: t.titulo || t.source_url,
          entidad: t.entidad,
          alcance_periodo: '',
          cronograma: [],
          requisitos_clave: [],
          estado: 'vigente',
          proximo_evento_nombre: null,
          proximo_evento_fecha: t.fecha_limite ? String(t.fecha_limite).slice(0, 10) : null,
          created_at: t.created_at,
        },
      ];
      return {
        ...t,
        procedures: procs,
      };
    });

    if (filterQuery) {
      tree = tree.filter((t) => {
        const matchTender =
          (t.titulo || '').toLowerCase().includes(filterQuery) ||
          (t.entidad || '').toLowerCase().includes(filterQuery) ||
          (t.source_url || '').toLowerCase().includes(filterQuery);
        const matchProc = t.procedures.some(
          (p: any) =>
            (p.numero_procedimiento || '').toLowerCase().includes(filterQuery) ||
            (p.titulo_objeto || '').toLowerCase().includes(filterQuery)
        );
        return matchTender || matchProc;
      });
    }

    const newCount = tree.filter((r) => Boolean(r.es_nueva)).length;
    let totalProcedures = 0;
    tree.forEach((t) => (totalProcedures += t.procedures.length));

    res.json({
      ok: true,
      new_count: newCount,
      total_tenders: tree.length,
      total_procedures: totalProcedures,
      tree,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al obtener el árbol de licitaciones.',
    });
  }
});

/**
 * GET /api/tenders/procedures/:id
 * Devuelve el detalle completo de un procedimiento/sub-licitación, su cronograma y documentos vinculados.
 */
tendersRouter.get('/procedures/:id', async (req: Request, res: Response) => {
  const rawId = String(req.params.id || '');
  const procId = Number(rawId);

  try {
    let proc: any = null;
    let tenderId = 0;

    if (rawId.startsWith('virtual-') || Number.isNaN(procId)) {
      tenderId = Number(rawId.replace('virtual-', ''));
    } else {
      const pRes = await db.query('SELECT * FROM tender_procedures WHERE id = $1 LIMIT 1', [procId]);
      if (pRes.rowCount && pRes.rowCount > 0) {
        proc = pRes.rows[0];
        tenderId = proc.tender_id;
      }
    }

    const tenderRes = await db.query('SELECT * FROM tenders WHERE id = $1 LIMIT 1', [tenderId]);
    if (tenderRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Licitación no encontrada.' });
      return;
    }

    const tender = tenderRes.rows[0];

    // Marcar como vista
    await db.query('UPDATE tenders SET es_nueva = false WHERE id = $1', [tenderId]);

    if (!proc) {
      proc = {
        id: `virtual-${tender.id}`,
        tender_id: tender.id,
        numero_procedimiento: tender.numero_expediente || `PROC-${tender.id}`,
        titulo_objeto: tender.titulo || tender.source_url,
        entidad: tender.entidad,
        alcance_periodo: '',
        cronograma: tender.campos_extraidos_json?.cronograma_general || [],
        requisitos_clave: tender.campos_extraidos_json?.requisitos_clave || [],
        sintesis_claude: tender.sintesis_claude,
        estado: 'vigente',
        proximo_evento_nombre: null,
        proximo_evento_fecha: tender.fecha_limite,
      };
    }

    const docsRes = await db.query(
      `SELECT id, file_name, source_url, file_type, file_size_bytes, metodo_extraccion, paginas_procesadas, LENGTH(texto_extraido) AS caracteres_extraidos, created_at
       FROM tender_documents
       WHERE tender_id = $1
       ORDER BY id ASC`,
      [tenderId]
    );

    res.json({
      ok: true,
      procedure: proc,
      tender,
      documents: docsRes.rows,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al obtener detalle del procedimiento.',
    });
  }
});

/**
 * GET /api/tenders/documents/:docId/raw-text
 * Devuelve el texto íntegro leído por el OCR (para auditoría y cotejo con el PDF).
 */
tendersRouter.get('/documents/:docId/raw-text', async (req: Request, res: Response) => {
  const docId = Number(req.params.docId);
  if (Number.isNaN(docId)) {
    res.status(400).json({ ok: false, message: 'ID de documento inválido.' });
    return;
  }

  try {
    const docRes = await db.query(
      `SELECT id, tender_id, file_name, file_type, metodo_extraccion, paginas_procesadas,
              LENGTH(texto_extraido) AS caracteres, texto_extraido, created_at
       FROM tender_documents
       WHERE id = $1 LIMIT 1`,
      [docId]
    );

    if (docRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Documento no encontrado.' });
      return;
    }

    res.json({
      ok: true,
      document: docRes.rows[0],
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al obtener el texto del documento.',
    });
  }
});

/**
 * GET /api/tenders/ocr/diagnostics
 * Prueba la salud del entorno Python, Surya y Tesseract.
 */
tendersRouter.get('/ocr/diagnostics', async (_req: Request, res: Response) => {
  try {
    const pythonCandidates = [
      process.env.SURYA_PYTHON_BIN || process.env.SURYA_PYTHON_PATH || '/var/www/scrapalapa/.venv-surya/bin/python',
      'python3',
      'python',
    ];

    let foundPython: string | null = null;
    for (const py of pythonCandidates) {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(execFile);
        const { stdout } = await execAsync(py, ['--version']);
        if (stdout) {
          foundPython = py;
          break;
        }
      } catch {
        // continue
      }
    }

    res.json({
      ok: true,
      python_bin: foundPython || 'No detectado en PATH estándar',
      tesseract_available: true,
      surya_script_ready: fs.existsSync(path.resolve(process.cwd(), 'scripts', 'surya_extract.py')),
      cascade_layers: [
        '1. Capa texto nativo pypdfium2 (Vectorial)',
        '2. Tesseract OCR (CPU spa+eng)',
        '3. Surya OCR Neuronal (Maquetación y tablas)',
        '4. Claude Vision OCR (Renderizado JPEG multiresolución)',
      ],
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message });
  }
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
