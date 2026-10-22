import fs from 'node:fs';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import {
  lightpandaService,
  normalizeForSearch,
  parseKeywordsList,
  KeywordHit,
} from '../scraper/lightpanda.service.js';
import { documentProcessorService, ProcessedDocumentResult } from '../scraper/document-processor.service.js';
import { claudeService } from '../llm/claude.service.js';
import { TenderExtractionSchema, TaskNameSchema } from '../llm/llm.schemas.js';

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
 * Motor local de reglas deterministas (se ejecuta siempre sobre el texto de Lightpanda + Surya)
 */
function runLocalRulesExtraction(text: string, fallbackTitle: string) {
  const expedienteMatch = text.match(
    /\b([A-Z]{2,4}-[0-9A-Z]{3,}-[0-9A-Z-]+|LPN-[0-9A-Z-]+|LA-[0-9A-Z-]+|LIC-[0-9A-Z-]+)\b/i
  );
  const montoMatches = Array.from(text.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)/g));
  const fechaMatches = Array.from(
    text.matchAll(/\b(20\d{2}[-/]\d{2}[-/]\d{2}|\d{1,2}\s+de\s+[a-zA-Záéíóú]+\s+de\s+20\d{2})\b/gi)
  );
  const emailMatches = Array.from(
    text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)
  );

  let montoNumerico: number | null = null;
  if (montoMatches.length > 0) {
    const rawNum = montoMatches[0][1].replace(/,/g, '');
    const parsed = Number(rawNum);
    if (!Number.isNaN(parsed)) montoNumerico = parsed;
  }

  return {
    titulo_detectado: fallbackTitle,
    expediente_detectado: expedienteMatch ? expedienteMatch[0] : null,
    montos_encontrados: montoMatches.slice(0, 5).map((m) => m[0]),
    monto_principal: montoNumerico,
    fechas_encontradas: fechaMatches.slice(0, 6).map((f) => f[0]),
    fecha_principal: fechaMatches[0]?.[0] || null,
    correos_contacto: Array.from(new Set(emailMatches.map((e) => e[0]))).slice(0, 5),
    longitud_caracteres: text.length,
  };
}

/**
 * GET /api/tenders
 * Lista el historial de licitaciones procesadas.
 */
tendersRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT
         t.id, t.source_url, t.titulo, t.entidad, t.numero_expediente,
         t.presupuesto_estimado, t.moneda, t.fecha_limite, t.nivel_riesgo,
         t.estado, t.metodo_navegacion, t.modelo_utilizado,
         t.tokens_utilizados, t.costo_estimado, t.latencia_total_ms,
         t.keywords_buscadas, t.hits_encontrados,
         t.created_at,
         (SELECT COUNT(*)::int FROM tender_documents d WHERE d.tender_id = t.id) AS total_documentos
       FROM tenders t
       ORDER BY t.created_at DESC
       LIMIT 100`
    );

    res.json({
      ok: true,
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
 * Permite abrir o descargar en nuestro portal el archivo PDF/Word traído por el scraper.
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
 * Obtiene el detalle completo de una licitación y sus documentos procesados en Surya/Word.
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
 * Pipeline completo:
 * 1. Lee la URL con Lightpanda, busca las palabras clave indicadas (separadas por coma) y sigue los "Hits"
 * 2. Al detectar un "Hit", localiza y descarga el documento PDF/Word de la licitación a nuestro portal y lo procesa en Surya OCR / Mammoth
 * 3. Ejecuta motor de reglas locales
 * 4. Envía a Claude para extracción estructurada JSON + síntesis ejecutiva
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

  const {
    url,
    keywords,
    ocr_mode,
    process_attachments,
    max_attachments,
    auth_username,
    auth_password,
    auth_login_url,
  } = parsed.data;

  const keywordsList = parseKeywordsList(keywords);
  const startTotal = Date.now();

  const insertRes = await db.query<{ id: number }>(
    `INSERT INTO tenders (source_url, titulo, estado, keywords_buscadas)
     VALUES ($1, $2, 'procesando', $3)
     RETURNING id`,
    [url, url, keywordsList.join(', ') || null]
  );
  const tenderId = insertRes.rows[0].id;

  try {
    // PASO 1: Navegar URL con Lightpanda, buscar palabras clave y seguir Hits
    const pageData = await lightpandaService.readTenderUrl(
      url,
      auth_username && auth_password
        ? {
            username: auth_username,
            password: auth_password,
            loginUrl: auth_login_url || undefined,
          }
        : undefined,
      keywordsList
    );

    // Seleccionar documentos a descargar:
    // Si se especificaron palabras clave y existen documentos asociados a un "Hit", priorizarlos
    const hitSpecificAttachments = pageData.attachments.filter((a) => Boolean(a.matchedKeyword));
    const candidateAttachments =
      keywordsList.length > 0 && hitSpecificAttachments.length > 0
        ? hitSpecificAttachments
        : pageData.attachments;

    const attachmentsToProcess = process_attachments
      ? candidateAttachments.slice(0, max_attachments)
      : pageData.isDirectDocumentUrl
        ? candidateAttachments.slice(0, 1)
        : [];

    // PASO 2: Descargar documentos a nuestro portal y procesarlos en Surya OCR / Word
    const processedDocs: ProcessedDocumentResult[] = [];
    for (const att of attachmentsToProcess) {
      try {
        const docResult = await documentProcessorService.downloadAndProcessDocument(
          att.url,
          att.fileType,
          ocr_mode,
          {
            cookie: pageData.sessionCookieHeader,
            authorization: pageData.basicAuthHeader,
          }
        );
        processedDocs.push(docResult);

        await db.query(
          `INSERT INTO tender_documents (
            tender_id, file_name, source_url, file_type,
            file_size_bytes, local_path, metodo_extraccion,
            paginas_procesadas, texto_extraido
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            tenderId,
            docResult.fileName,
            docResult.sourceUrl,
            docResult.fileType,
            docResult.fileSizeBytes,
            docResult.localPath,
            docResult.extractionMethod,
            docResult.pagesProcessed,
            docResult.extractedText,
          ]
        );
      } catch (docErr: any) {
        console.warn(`[Ingest] No se pudo procesar anexo ${att.url}:`, docErr?.message);
      }
    }

    // Verificar también Hits de palabras clave dentro del texto extraído de los documentos PDF/Word (por ejemplo cuando la URL era un PDF escaneado directo)
    const allKeywordHits: KeywordHit[] = [...pageData.keywordHits];
    if (keywordsList.length > 0 && processedDocs.length > 0) {
      const normalizedKws = keywordsList.map((kw) => ({
        original: kw,
        norm: normalizeForSearch(kw),
      }));
      const seenDocSnippets = new Set(
        allKeywordHits.map((h) => normalizeForSearch(h.contextSnippet.slice(0, 90)))
      );

      for (const doc of processedDocs) {
        const lines = doc.extractedText
          .split(/\n+/)
          .map((l) => l.trim())
          .filter((l) => l.length > 18);

        for (const line of lines) {
          const normLine = normalizeForSearch(line);
          const matchedInLine = normalizedKws
            .filter((k) => normLine.includes(k.norm))
            .map((k) => k.original);

          if (matchedInLine.length > 0) {
            const snippetKey = normLine.slice(0, 90);
            if (seenDocSnippets.has(snippetKey)) continue;
            seenDocSnippets.add(snippetKey);

            allKeywordHits.push({
              matchedKeywords: matchedInLine,
              contextSnippet: `[${doc.fileName}] ${line.slice(0, 280)}`,
              sourceUrl: doc.sourceUrl,
              documentUrls: [doc.sourceUrl],
            });
          }
        }
      }
    }

    // Consolidar el texto de la página (Lightpanda) + Hits + el texto extraído de documentos (Surya / Word)
    const hitsSummaryText =
      keywordsList.length > 0
        ? allKeywordHits.length > 0
          ? `=== COINCIDENCIAS ("HITS") DE PALABRAS CLAVE [${keywordsList.join(', ')}] ===\n` +
            allKeywordHits
              .map(
                (h, i) =>
                  `Hit #${i + 1} (Palabras: ${h.matchedKeywords.join(', ')}): ${h.contextSnippet}` +
                  (h.documentUrls.length > 0 ? ` | Documentos: ${h.documentUrls.join(', ')}` : '')
              )
              .join('\n')
          : `=== BÚSQUEDA DE PALABRAS CLAVE [${keywordsList.join(', ')}]: SIN COINCIDENCIAS ("0 HITS") EN LA PÁGINA ===`
        : '';

    const docsCombinedText = processedDocs
      .map(
        (d, idx) =>
          `=== DOCUMENTO ${idx + 1}: ${d.fileName} (Método: ${d.extractionMethod}, Páginas: ${d.pagesProcessed}) ===\n${d.extractedText}`
      )
      .join('\n\n');

    const fullConsolidatedText = [
      `URL ORIGEN: ${pageData.finalUrl}`,
      `TÍTULO PÁGINA: ${pageData.title}`,
      hitsSummaryText,
      pageData.pageText ? `=== CONTENIDO DE LA PÁGINA WEB (LIGHTPANDA) ===\n${pageData.pageText}` : '',
      docsCombinedText ? `=== CONTENIDO EXTRAÍDO DE DOCUMENTOS (SURYA OCR / WORD) ===\n${docsCombinedText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    // PASO 3: Reglas deterministas locales
    const localRules = {
      ...runLocalRulesExtraction(fullConsolidatedText, pageData.title),
      keywords_buscadas: keywordsList,
      total_hits: allKeywordHits.length,
    };

    // PASO 4: Enviar a Claude para Extracción Estructurada JSON (completar_campos) y Síntesis (resumen_licitacion)
    let structuredFields: any = null;
    let claudeSynthesis: string | null = null;
    let modelUsed = 'local_surya_rules';
    let totalTokens = 0;
    let totalCostUsd = 0;
    let fallbackUsed = false;
    let fallbackReason: string | undefined;

    const keywordInstruction =
      keywordsList.length > 0
        ? `\nIMPORTANTE: El usuario buscó específicamente las palabras clave: [${keywordsList.join(', ')}]. Prioriza la licitación y los documentos que hicieron "hit" con estas palabras clave.\n`
        : '';

    try {
      const extractionRes = await claudeService.extractStructuredJson({
        tarea: 'completar_campos',
        userPrompt: keywordInstruction + fullConsolidatedText,
        toolName: 'extraer_campos_licitacion',
        toolDescription: 'Extrae los datos principales de la licitación a partir del contenido de la página y documentos OCR.',
        zodSchema: TenderExtractionSchema,
        tenderId: `TND-${tenderId}`,
        documentId: processedDocs[0]?.fileName || 'WEB-PAGE',
      });

      if (extractionRes.fallbackLocalUsed) {
        fallbackUsed = true;
        fallbackReason = extractionRes.fallbackReason;
      } else if (extractionRes.ok && extractionRes.data) {
        structuredFields = extractionRes.data;
        modelUsed = extractionRes.model;
        totalTokens +=
          extractionRes.usage.inputTokens +
          extractionRes.usage.outputTokens +
          extractionRes.usage.cacheCreationInputTokens +
          extractionRes.usage.cacheReadInputTokens;
        totalCostUsd += extractionRes.usage.estimatedCostUsd;
      }
    } catch (extractErr: any) {
      console.warn('[Ingest] Aviso en extracción estructurada:', extractErr?.message);
    }

    try {
      const synthesisRes = await claudeService.generateTaskText({
        tarea: 'resumen_licitacion',
        userPrompt:
          `Analiza la siguiente información extraída de la URL (${pageData.finalUrl}) y sus documentos adjuntos.\n` +
          (keywordsList.length > 0
            ? `El usuario buscó específicamente las palabras clave: "${keywordsList.join(', ')}" (se detectaron ${allKeywordHits.length} coincidencias/hits).\n`
            : '') +
          `Elabora una síntesis ejecutiva estructurada con:\n` +
          `1. Coincidencias de palabras clave detectadas y objeto de la licitación\n` +
          `2. Entidad convocante, presupuesto, moneda y plazos/fechas clave\n` +
          `3. Requisitos técnicos, legales y financieros obligatorios extraídos del documento\n` +
          `4. Documentos traídos al portal y observaciones relevantes.\n\n` +
          fullConsolidatedText,
        tenderId: `TND-${tenderId}`,
        documentId: processedDocs[0]?.fileName || 'WEB-PAGE',
      });

      if (synthesisRes.fallbackLocalUsed) {
        fallbackUsed = true;
        fallbackReason = synthesisRes.fallbackReason;
      } else if (synthesisRes.ok && synthesisRes.data) {
        claudeSynthesis = synthesisRes.data;
        modelUsed = synthesisRes.model;
        fallbackUsed = false;
        fallbackReason = undefined;
        totalTokens +=
          synthesisRes.usage.inputTokens +
          synthesisRes.usage.outputTokens +
          synthesisRes.usage.cacheCreationInputTokens +
          synthesisRes.usage.cacheReadInputTokens;
        totalCostUsd += synthesisRes.usage.estimatedCostUsd;
      }
    } catch (claudeErr: any) {
      if (!structuredFields) {
        fallbackUsed = true;
        fallbackReason = claudeErr?.message || 'Error al generar la síntesis con IA.';
      }
    }

    const totalLatencyMs = Date.now() - startTotal;

    const finalTitle = structuredFields?.titulo_licitacion || pageData.title || url;
    const finalEntidad = structuredFields?.entidad_convocante || null;
    const finalExpediente = localRules.expediente_detectado || null;
    const finalPresupuesto =
      structuredFields?.presupuesto_estimado ?? localRules.monto_principal ?? null;
    const finalMoneda = structuredFields?.moneda || 'MXN';
    const finalFecha =
      structuredFields?.fecha_limite_propuestas || localRules.fecha_principal || null;
    const finalRiesgo = structuredFields?.nivel_riesgo || null;

    await db.query(
      `UPDATE tenders SET
        titulo = $1,
        entidad = $2,
        numero_expediente = $3,
        presupuesto_estimado = $4,
        moneda = $5,
        fecha_limite = $6,
        nivel_riesgo = $7,
        estado = 'completado',
        metodo_navegacion = $8,
        contenido_pagina_texto = $9,
        texto_documentos_ocr = $10,
        extraccion_reglas_locales = $11::jsonb,
        campos_extraidos_json = $12::jsonb,
        sintesis_claude = $13,
        modelo_utilizado = $14,
        tokens_utilizados = $15,
        costo_estimado = $16,
        latencia_total_ms = $17,
        keywords_buscadas = $18,
        hits_encontrados = $19::jsonb,
        updated_at = NOW()
       WHERE id = $20`,
      [
        finalTitle.slice(0, 295),
        finalEntidad ? String(finalEntidad).slice(0, 250) : null,
        finalExpediente ? String(finalExpediente).slice(0, 145) : null,
        finalPresupuesto,
        finalMoneda,
        finalFecha ? String(finalFecha).slice(0, 75) : null,
        finalRiesgo,
        pageData.methodUsed,
        pageData.pageText,
        docsCombinedText,
        JSON.stringify(localRules),
        structuredFields ? JSON.stringify(structuredFields) : null,
        claudeSynthesis,
        modelUsed,
        totalTokens,
        Number(totalCostUsd.toFixed(6)),
        totalLatencyMs,
        keywordsList.join(', ') || null,
        JSON.stringify(allKeywordHits),
        tenderId,
      ]
    );

    const updatedTender = await db.query('SELECT * FROM tenders WHERE id = $1', [tenderId]);
    const savedDocs = await db.query('SELECT * FROM tender_documents WHERE tender_id = $1 ORDER BY id ASC', [
      tenderId,
    ]);

    res.json({
      ok: true,
      tender: updatedTender.rows[0],
      documents: savedDocs.rows,
      discovered_attachments: pageData.attachments,
      keywords_searched: keywordsList,
      keyword_hits: allKeywordHits,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
    });
  } catch (err: any) {
    const totalLatencyMs = Date.now() - startTotal;
    await db.query(
      `UPDATE tenders SET estado = 'error', error_detalle = $1, latencia_total_ms = $2, updated_at = NOW() WHERE id = $3`,
      [err?.message || String(err), totalLatencyMs, tenderId]
    );
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
