import crypto from 'node:crypto';
import { db } from '../../db/pool.js';
import {
  lightpandaService,
  normalizeForSearch,
  parseKeywordsList,
  KeywordHit,
} from '../scraper/lightpanda.service.js';
import { documentProcessorService, ProcessedDocumentResult } from '../scraper/document-processor.service.js';
import { claudeService } from '../llm/claude.service.js';
import { TenderExtractionSchema } from '../llm/llm.schemas.js';

export interface IngestTenderInput {
  url: string;
  keywords?: string | string[];
  ocrMode?: 'auto' | 'forzar_surya';
  processAttachments?: boolean;
  maxAttachments?: number;
  authUsername?: string;
  authPassword?: string;
  authLoginUrl?: string;
  sourceId?: number;
  defaultEntidad?: string;
  skipIfDuplicate?: boolean;
}

/**
 * Calcula una huella SHA-256 determinista a partir de:
 * (número de procedimiento + título + entidad) normalizados.
 */
export function computeTenderDedupHash(params: {
  numeroExpediente?: string | null;
  titulo?: string | null;
  entidad?: string | null;
  sourceUrl: string;
  hitsSignature?: string;
}): string {
  const norm = (v?: string | null) =>
    normalizeForSearch(v || '')
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 140);

  let host = '';
  try {
    host = new URL(params.sourceUrl).hostname.toLowerCase();
  } catch {
    host = params.sourceUrl.slice(0, 60);
  }

  const entidadPart = norm(params.entidad) || norm(host);
  const expPart = norm(params.numeroExpediente);
  const titlePart = norm(params.titulo);
  const hitsPart = norm(params.hitsSignature);

  const compositeKey = `${entidadPart}|${expPart}|${titlePart}|${hitsPart}`;
  return crypto.createHash('sha256').update(compositeKey).digest('hex');
}

/**
 * Motor local de reglas deterministas sobre el texto consolidado.
 */
export function runLocalRulesExtraction(text: string, fallbackTitle: string) {
  const expedienteMatch = text.match(
    /\b([A-Z]{2,6}\/[A-Z]{2,5}-[0-9]{2,4}\/20\d{2}|[A-Z]{2,4}-[0-9A-Z]{3,}-[0-9A-Z-]+|LPN-[0-9A-Z-]+|LA-[0-9A-Z-]+|LIC-[0-9A-Z-]+)\b/i
  );
  const montoMatches = Array.from(text.matchAll(/\$\s?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?)/g));
  const fechaMatches = Array.from(
    text.matchAll(/\b(20\d{2}[-/]\d{2}[-/]\d{2}|\d{2}\/\d{2}\/20\d{2}|\d{1,2}\s+de\s+[a-zA-Záéíóú]+\s+de\s+20\d{2})\b/gi)
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
 * Servicio unificado de ingesta de licitaciones (usado tanto por el formulario manual como por el Scheduler automático).
 */
export class TenderIngestionService {
  async ingestFromUrl(input: IngestTenderInput) {
    const {
      url,
      keywords,
      ocrMode = 'auto',
      processAttachments = true,
      maxAttachments = 8,
      authUsername,
      authPassword,
      authLoginUrl,
      sourceId,
      defaultEntidad,
      skipIfDuplicate = false,
    } = input;

    const keywordsList = parseKeywordsList(keywords);
    const startTotal = Date.now();

    // PASO 1: Navegar URL con Lightpanda, buscar palabras clave y seguir Hits
    const pageData = await lightpandaService.readTenderUrl(
      url,
      authUsername && authPassword
        ? {
            username: authUsername,
            password: authPassword,
            loginUrl: authLoginUrl || undefined,
          }
        : undefined,
      keywordsList
    );

    // En ejecución automática por fuente: si se especificaron palabras clave y no hubo ningún hit ni PDF directo, omitir sin crear registro basura
    if (
      skipIfDuplicate &&
      keywordsList.length > 0 &&
      pageData.keywordHits.length === 0 &&
      !pageData.isDirectDocumentUrl &&
      pageData.attachments.length === 0
    ) {
      return {
        ok: true,
        skippedNoHits: true,
        skippedDuplicate: false,
        hitsCount: 0,
        newTendersCount: 0,
        duplicateTendersCount: 0,
      };
    }

    // Pre-chequeo de deduplicación antes de gastar tokens de IA (cuando proviene del Scheduler automático)
    const preRules = runLocalRulesExtraction(pageData.pageText, pageData.title);
    const hitsSignature = pageData.keywordHits
      .slice(0, 10)
      .map((h) => h.contextSnippet.slice(0, 80))
      .join('||');

    const preDedupHash = computeTenderDedupHash({
      numeroExpediente: preRules.expediente_detectado,
      titulo: pageData.title,
      entidad: defaultEntidad || null,
      sourceUrl: url,
      hitsSignature,
    });

    if (skipIfDuplicate) {
      const existingCheck = await db.query(
        'SELECT id, titulo FROM tenders WHERE dedup_hash = $1 LIMIT 1',
        [preDedupHash]
      );
      if (existingCheck.rowCount && existingCheck.rowCount > 0) {
        return {
          ok: true,
          skippedDuplicate: true,
          skippedNoHits: false,
          existingTenderId: existingCheck.rows[0].id,
          hitsCount: pageData.keywordHits.length,
          newTendersCount: 0,
          duplicateTendersCount: Math.max(1, pageData.keywordHits.length),
        };
      }
    }

    // Crear registro en tenders
    const insertRes = await db.query<{ id: number }>(
      `INSERT INTO tenders (source_url, titulo, entidad, estado, keywords_buscadas, source_id, es_nueva)
       VALUES ($1, $2, $3, 'procesando', $4, $5, true)
       RETURNING id`,
      [url, pageData.title.slice(0, 295) || url, defaultEntidad || null, keywordsList.join(', ') || null, sourceId || null]
    );
    const tenderId = insertRes.rows[0].id;

    try {
      // Seleccionar documentos a descargar
      const hitSpecificAttachments = pageData.attachments.filter((a) => Boolean(a.matchedKeyword));
      const candidateAttachments =
        keywordsList.length > 0 && hitSpecificAttachments.length > 0
          ? hitSpecificAttachments
          : pageData.attachments;

      const attachmentsToProcess = processAttachments
        ? candidateAttachments.slice(0, maxAttachments)
        : pageData.isDirectDocumentUrl
          ? candidateAttachments.slice(0, 1)
          : [];

      // PASO 2: Descargar documentos a nuestro portal y procesarlos con OCR
      const processedDocs: ProcessedDocumentResult[] = [];
      for (const att of attachmentsToProcess) {
        try {
          const docResult = await documentProcessorService.downloadAndProcessDocument(
            att.url,
            att.fileType,
            ocrMode,
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

      // Verificar también Hits de palabras clave dentro del texto extraído de los documentos PDF/Word
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
            : `=== BÚSQUEDA DE PALABRAS CLAVE [${keywordsList.join(', ')}]: SIN COINCIDENCIAS EN LA PÁGINA ===`
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
        pageData.pageText ? `=== CONTENIDO DE LA PÁGINA WEB ===\n${pageData.pageText}` : '',
        docsCombinedText ? `=== CONTENIDO EXTRAÍDO DE DOCUMENTOS ===\n${docsCombinedText}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      // PASO 3: Reglas deterministas locales
      const localRules = {
        ...runLocalRulesExtraction(fullConsolidatedText, pageData.title),
        keywords_buscadas: keywordsList,
        total_hits: allKeywordHits.length,
      };

      // PASO 4: Extracción estructurada y Síntesis con Claude
      let structuredFields: any = null;
      let claudeSynthesis: string | null = null;
      let modelUsed = 'local_rules';
      let totalTokens = 0;
      let totalCostUsd = 0;
      let fallbackUsed = false;
      let fallbackReason: string | undefined;

      const keywordInstruction =
        keywordsList.length > 0
          ? `\nIMPORTANTE: El usuario buscó específicamente las palabras clave: [${keywordsList.join(', ')}]. Prioriza las licitaciones y los documentos que hicieron "hit" con estas palabras clave.\n`
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
            `1. Coincidencias de palabras clave detectadas y objeto de la(s) licitación(es)\n` +
            `2. Entidad convocante, presupuesto/costo de bases, moneda y plazos/fechas clave\n` +
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
      const finalEntidad = structuredFields?.entidad_convocante || defaultEntidad || null;
      const finalExpediente = localRules.expediente_detectado || null;
      const finalPresupuesto =
        structuredFields?.presupuesto_estimado ?? localRules.monto_principal ?? null;
      const finalMoneda = structuredFields?.moneda || 'MXN';
      const finalFecha =
        structuredFields?.fecha_limite_propuestas || localRules.fecha_principal || null;
      const finalRiesgo = structuredFields?.nivel_riesgo || null;

      // Si ya existe otro registro con el mismo preDedupHash (ej. corrida manual repetida), dejar dedup_hash en null en la copia manual o asignarlo si está libre
      const hashExists = await db.query(
        'SELECT id FROM tenders WHERE dedup_hash = $1 AND id <> $2 LIMIT 1',
        [preDedupHash, tenderId]
      );
      const dedupHashToSave = hashExists.rowCount && hashExists.rowCount > 0 ? null : preDedupHash;

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
          dedup_hash = $20,
          updated_at = NOW()
         WHERE id = $21`,
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
          dedupHashToSave,
          tenderId,
        ]
      );

      const updatedTender = await db.query('SELECT * FROM tenders WHERE id = $1', [tenderId]);
      const savedDocs = await db.query(
        'SELECT * FROM tender_documents WHERE tender_id = $1 ORDER BY id ASC',
        [tenderId]
      );

      return {
        ok: true,
        skippedDuplicate: false,
        skippedNoHits: false,
        tender: updatedTender.rows[0],
        documents: savedDocs.rows,
        discovered_attachments: pageData.attachments,
        keywords_searched: keywordsList,
        keyword_hits: allKeywordHits,
        hitsCount: allKeywordHits.length,
        newTendersCount: 1,
        duplicateTendersCount: 0,
        fallback_used: fallbackUsed,
        fallback_reason: fallbackReason,
      };
    } catch (err: any) {
      const totalLatencyMs = Date.now() - startTotal;
      await db.query(
        `UPDATE tenders SET estado = 'error', error_detalle = $1, latencia_total_ms = $2, updated_at = NOW() WHERE id = $3`,
        [err?.message || String(err), totalLatencyMs, tenderId]
      );
      throw err;
    }
  }
}

export const tenderIngestionService = new TenderIngestionService();
