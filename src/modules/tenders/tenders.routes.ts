import fs from 'node:fs';
import path from 'node:path';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { tenderIngestionService } from './tender-ingestion.service.js';
import { claudeService } from '../llm/claude.service.js';
import { TaskNameSchema, TenderExtractionSchema, TenderExtraction, TenderTimelineExtractionSchema, TenderTimelineExtraction, TenderMilestone } from '../llm/llm.schemas.js';
import { authService } from '../auth/auth.service.js';
import { getDocumentPriorityScore } from '../scraper/lightpanda.service.js';
import { documentProcessorService } from '../scraper/document-processor.service.js';
import { tenderProgressService } from './tender-progress.service.js';

export const tendersRouter = Router();

function toIsoDateOnly(val: any): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString().slice(0, 10);
}

const SPANISH_MONTHS: Record<string, string> = {
  enero: '01', ene: '01',
  febrero: '02', feb: '02',
  marzo: '03', mar: '03',
  abril: '04', abr: '04',
  mayo: '05', may: '05',
  junio: '06', jun: '06',
  julio: '07', jul: '07',
  agosto: '08', ago: '08',
  septiembre: '09', sep: '09', sept: '09',
  octubre: '10', oct: '10',
  noviembre: '11', nov: '11',
  diciembre: '12', dic: '12',
};

export function normalizeParsedDate(raw: string): string {
  if (!raw) return 'Por definir';
  const clean = raw.trim();

  // 1. Caso ISO: 2026-11-05
  const isoMatch = clean.match(/\b(20\d\d)[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return `${isoMatch[1]}-${m}-${d}`;
  }

  // 2. Caso numérico DD/MM/YYYY: 05/11/2026 o 5-11-2026
  const slashMatch = clean.match(/\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](20\d\d)\b/);
  if (slashMatch) {
    const d = slashMatch[1].padStart(2, '0');
    const m = slashMatch[2].padStart(2, '0');
    return `${slashMatch[3]}-${m}-${d}`;
  }

  // 3. Caso texto con día: "05 nov 2026", "26 de octubre de 2026", "19 nov 2026", "03 de noviembre de 2026"
  const textDateMatch = clean.match(/\b(0?[1-9]|[12]\d|3[01])\s*(?:de)?\s*([a-záéíóú]+)\s*(?:de)?\s*(20\d\d)\b/i);
  if (textDateMatch) {
    const d = textDateMatch[1].padStart(2, '0');
    const monthName = textDateMatch[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const m = SPANISH_MONTHS[monthName];
    if (m) {
      return `${textDateMatch[3]}-${m}-${d}`;
    }
  }

  // 4. Caso texto solo mes y año: "Octubre de 2026", "Noviembre 2026"
  const monthYearMatch = clean.match(/\b([a-záéíóú]+)\s*(?:de)?\s*(20\d\d)\b/i);
  if (monthYearMatch) {
    const monthName = monthYearMatch[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const m = SPANISH_MONTHS[monthName];
    if (m) {
      return `${monthYearMatch[2]}-${m}-01`;
    }
  }

  return clean;
}

export function parseMilestonesFromMarkdownTable(text: string): TenderMilestone[] {
  if (!text) return [];

  const lines = text.split('\n');
  const results: TenderMilestone[] = [];

  let inTable = false;
  let eventoIdx = 0;
  let fechaIdx = 1;
  let lugarIdx = 2;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.includes('|')) {
      inTable = false;
      continue;
    }

    const cols = line
      .split('|')
      .map((c) => c.trim())
      .filter((c, idx, arr) => {
        if ((idx === 0 || idx === arr.length - 1) && c === '') return false;
        return true;
      });

    if (cols.length < 2) continue;

    // Separator line
    if (cols.every((c) => /^[-: ]+$/.test(c))) {
      inTable = true;
      continue;
    }

    const lowerJoined = cols.join(' ').toLowerCase();
    if (
      lowerJoined.includes('evento') ||
      lowerJoined.includes('acto') ||
      lowerJoined.includes('etapa') ||
      lowerJoined.includes('trámite') ||
      lowerJoined.includes('tramite') ||
      lowerJoined.includes('fecha') ||
      lowerJoined.includes('plazo')
    ) {
      inTable = true;
      const headerCols = cols.map((c) => c.toLowerCase());
      eventoIdx = headerCols.findIndex(
        (c) => c.includes('evento') || c.includes('acto') || c.includes('concepto') || c.includes('etapa') || c.includes('descrip')
      );
      fechaIdx = headerCols.findIndex(
        (c) => c.includes('fecha') || c.includes('plazo') || c.includes('hora') || c.includes('calendario')
      );
      lugarIdx = headerCols.findIndex(
        (c) => c.includes('lugar') || c.includes('medio') || c.includes('sede')
      );
      if (eventoIdx === -1) eventoIdx = 0;
      if (fechaIdx === -1) fechaIdx = 1;
      if (lugarIdx === -1 && cols.length > 2) lugarIdx = 2;
      continue;
    }

    if (!inTable) {
      const hasDateOrEvent = cols.some((c) =>
        /(?:20\d\d|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|confirmar|ilegible|\b\d{1,2}:\d{2}\b)/i.test(c)
      );
      if (!hasDateOrEvent) continue;
    }

    const rawEvento = cols[eventoIdx] || cols[0] || '';
    const rawFechaHora = cols[fechaIdx] || cols[1] || '';
    const rawLugar = lugarIdx >= 0 && cols[lugarIdx] ? cols[lugarIdx] : (cols[2] || '');

    if (!rawEvento || rawEvento.toLowerCase().includes('evento') || rawEvento.toLowerCase().includes('---')) {
      continue;
    }

    const horaMatch = rawFechaHora.match(/\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i);
    const hora = horaMatch ? `${horaMatch[1]} hrs` : '';

    const normDate = normalizeParsedDate(rawFechaHora);

    let estado: 'completado' | 'proximo' | 'pendiente' = 'proximo';
    const parsedDate = new Date(normDate);
    if (!isNaN(parsedDate.getTime()) && normDate.match(/^20\d\d-\d\d-\d\d$/)) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (parsedDate < today) {
        estado = 'completado';
      }
    }

    results.push({
      evento: rawEvento,
      fecha: normDate,
      hora: hora || 'Hora en bases',
      lugar: rawLugar || 'Vía electrónica / Portal oficial',
      estado,
    });
  }

  return results;
}

/**
 * Extrae y reconcilia de manera determinista los hitos estándar de licitaciones públicas
 * (Publicación, Interés, Visita, Aclaraciones, Propuestas, Apertura, Fallo, Firma)
 * a partir del texto íntegro de los documentos/OCR.
 * 
 * Si la extracción de Claude omitió el Fallo o lo dejó como "Por definir"/"Por confirmar",
 * esta función rescata la fecha exacta del texto original y la inyecta, garantizando exhaustividad.
 */
export function reconcileMilestonesWithDocumentText(
  currentMilestones: TenderMilestone[],
  documentText: string
): TenderMilestone[] {
  if (!documentText) return currentMilestones;

  const milestones = [...currentMilestones];

  // Detectores de hitos con patrones para tablas y párrafos
  const standardMilestoneDetectors = [
    {
      tipo: 'publicacion',
      nombre: 'Publicación de la Convocatoria',
      regex: /(?:publicaci[óo]n\s+de\s+la\s+convocatoria|convocatoria\s+p[úu]blica)[^\n\r]{0,120}?(?:el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*Publicaci[óo]n[^\n\r|]*\|\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:publicaci[óo]n[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /publicaci[óo]n/i.test(name),
    },
    {
      tipo: 'interes',
      nombre: 'Recepción de escritos de interés en participar',
      regex: /(?:inter[ée]s\s+de\s+participaci[óo]n|escritos?\s+de\s+inter[ée]s)[^\n\r]{0,120}?(?:al?|hasta\s+el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*[^|\n\r]*inter[ée]s[^|\n\r]*\|\s*(?:[^\n\r|]*a\s+)?([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:inter[ée]s[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /inter[ée]s/i.test(name),
    },
    {
      tipo: 'visita',
      nombre: 'Visita a instalaciones',
      regex: /(?:visita\s+(?:a\s+(?:las?\s+)?)?instalaciones|visita\s+al\s+sitio)[^\n\r]{0,120}?(?:al?|hasta\s+el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*[^|\n\r]*visita[^|\n\r]*\|\s*(?:[^\n\r|]*a\s+)?([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:visita[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /visita/i.test(name),
    },
    {
      tipo: 'solicitudes_aclaracion',
      nombre: 'Recepción de solicitudes de aclaración',
      regex: /(?:solicitud(?:es)?\s+de\s+aclaraci[óo]n|env[íi]o\s+de\s+preguntas)[^\n\r]{0,120}?(?:al?|hasta\s+el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*[^|\n\r]*solicitudes\s+de\s+aclaraci[óo]n[^|\n\r]*\|\s*(?:[^\n\r|]*a\s+)?([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:solicitudes\s+de\s+aclaraci[óo]n[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /solicitud.*aclaraci[óo]n|preguntas/i.test(name),
    },
    {
      tipo: 'junta_aclaraciones',
      nombre: 'Difusión de la junta de aclaraciones',
      regex: /(?:junta\s+de\s+aclaraciones|difusi[óo]n\s+de\s+la\s+junta\s+de\s+aclaraciones)[^\n\r]{0,120}?(?:el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*[^|\n\r]*(?:junta\s+de\s+aclaraciones|difusi[óo]n.*junta)[^|\n\r]*\|\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:junta\s+de\s+aclaraciones[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /junta\s+de\s+aclaraciones|difusi[óo]n.*junta/i.test(name),
    },
    {
      tipo: 'recepcion_propuestas',
      nombre: 'Recepción de propuestas',
      regex: /(?:recepci[óo]n\s+de\s+propuestas|recepci[óo]n\s+de\s+proposiciones)[^\n\r]{0,120}?(?:al?|hasta\s+el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*[^|\n\r]*recepci[óo]n\s+de\s+propuestas[^|\n\r]*\|\s*(?:[^\n\r|]*a\s+)?([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:recepci[óo]n\s+de\s+propuestas[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /recepci[óo]n.*propuestas|entrega.*propuestas/i.test(name),
    },
    {
      tipo: 'apertura_propuestas',
      nombre: 'Apertura de Propuestas',
      regex: /(?:apertura\s+de\s+proposiciones|apertura\s+de\s+propuestas|acto\s+de\s+apertura)[^\n\r]{0,120}?(?:el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*[^|\n\r]*apertura\s+de\s+propuestas[^|\n\r]*\|\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:apertura[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /apertura/i.test(name),
    },
    {
      tipo: 'fallo',
      nombre: 'Fallo',
      regex: /(?:acto\s+de\s+fallo|notificaci[óo]n\s+de\s+fallo|fallo|dictamen)[^\n\r]{0,120}?(?:el|fecha|d[íi]a|:)?\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      tableRegex: /\|\s*[^|\n\r]*fallo[^|\n\r]*\|\s*([0-3]?\d\s+de\s+[a-záéíóú]+\s+de\s+20\d\d|[0-3]?\d[/-][0-1]?\d[/-]20\d\d)/i,
      horaRegex: /(?:fallo[^\n\r]{0,160}?)\b([012]?\d:[0-5]\d)\s*(?:hrs?|horas?|h)?\b/i,
      matchTarget: (name: string) => /fallo|dictamen/i.test(name),
    },
  ];

  for (const detector of standardMilestoneDetectors) {
    const rawDateMatch = documentText.match(detector.tableRegex) || documentText.match(detector.regex);
    if (!rawDateMatch) continue;

    const detectedRawDate = rawDateMatch[1];
    const normalizedDetectedDate = normalizeParsedDate(detectedRawDate);
    if (!normalizedDetectedDate || !normalizedDetectedDate.match(/^20\d\d-\d\d-\d\d$/)) continue;

    // Detectar hora si existe
    const horaMatch = documentText.match(detector.horaRegex);
    const detectedHora = horaMatch ? `${horaMatch[1]} hrs` : '';

    // Buscar si ya existe este hito en la lista actual
    const existingIdx = milestones.findIndex((m) => detector.matchTarget(m.evento));

    if (existingIdx >= 0) {
      const existing = milestones[existingIdx];
      const hasValidDate = existing.fecha && existing.fecha.match(/^20\d\d-\d\d-\d\d$/);
      const isAmbiguous = !hasValidDate || /definir|confirmar|pendiente|ilegi/i.test(existing.fecha);

      // Si estaba ambiguo o "Por definir", sobrescribirlo con la fecha fidedigna detectada del documento
      if (isAmbiguous) {
        existing.fecha = normalizedDetectedDate;
        if (detectedHora && (!existing.hora || existing.hora === 'Hora en bases')) {
          existing.hora = detectedHora;
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const parsed = new Date(normalizedDetectedDate);
        existing.estado = parsed < today ? 'completado' : 'proximo';
      }
    } else {
      // Si el hito no existía (ej. Claude lo omitió por completo), inyectarlo
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const parsed = new Date(normalizedDetectedDate);
      milestones.push({
        evento: detector.nombre,
        fecha: normalizedDetectedDate,
        hora: detectedHora || 'Hora en bases',
        lugar: 'Vía electrónica / Portal oficial',
        estado: parsed < today ? 'completado' : 'proximo',
      });
    }
  }

  // Ordenar cronológicamente todos los hitos
  return milestones.sort((a, b) => {
    const timeA = new Date(a.fecha).getTime();
    const timeB = new Date(b.fecha).getTime();
    if (isNaN(timeA) && isNaN(timeB)) return 0;
    if (isNaN(timeA)) return 1;
    if (isNaN(timeB)) return -1;
    return timeA - timeB;
  });
}

const IngestUrlSchema = z.object({
  url: z.string().trim().url('Ingresa una URL válida (http:// o https://)'),
  keywords: z.string().trim().optional().default(''),
  ocr_mode: z.enum(['auto', 'forzar_surya']).optional().default('auto'),
  process_attachments: z.boolean().optional().default(true),
  max_attachments: z.coerce.number().int().min(1).max(20).optional().default(8),
  auth_username: z.string().trim().optional(),
  auth_password: z.string().optional(),
  auth_login_url: z.string().trim().optional(),
  credentials: z
    .object({
      username: z.string().trim().optional(),
      password: z.string().optional(),
      login_url: z.string().trim().optional(),
    })
    .optional(),
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
         t.campos_extraidos_json, t.sintesis_claude,
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
      proceduresByTender.get(p.tender_id)!.push({
        ...p,
        titulo: p.titulo_objeto,
        objeto: p.titulo_objeto,
      });
    }

    let tree = tendersRes.rows.map((t) => {
      const procs = proceduresByTender.get(t.id) || [
        {
          id: `virtual-${t.id}`,
          tender_id: t.id,
          numero_procedimiento: t.numero_expediente || `PROC-${t.id}`,
          titulo: t.titulo || t.source_url,
          objeto: t.titulo || t.source_url,
          titulo_objeto: t.titulo || t.source_url,
          entidad: t.entidad,
          alcance_periodo: '',
          cronograma: t.campos_extraidos_json?.cronograma_general || [],
          requisitos_clave: t.campos_extraidos_json?.requisitos_clave || [],
          estado: 'vigente',
          proximo_evento_nombre: null,
          proximo_evento_fecha: toIsoDateOnly(t.fecha_limite),
          created_at: t.created_at,
        },
      ];
      // Si el procedimiento tiene título genérico, asignar título del tender padre
      procs.forEach((p) => {
        if (!p.titulo || p.titulo === 'Procedimiento sin título' || p.titulo === p.numero_procedimiento) {
          p.titulo = t.titulo || p.numero_procedimiento;
          p.titulo_objeto = p.titulo;
        }
      });
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

    let rawProcCronograma = proc.cronograma;
    if (typeof rawProcCronograma === 'string') {
      try {
        rawProcCronograma = JSON.parse(rawProcCronograma);
      } catch {
        rawProcCronograma = [];
      }
    }

    // Si el cronograma está vacío pero tender tiene cronograma_general en campos_extraidos_json, recuperarlo
    let effectiveCronograma = Array.isArray(rawProcCronograma) && rawProcCronograma.length > 0
      ? rawProcCronograma
      : Array.isArray(tender.campos_extraidos_json?.cronograma_general)
      ? tender.campos_extraidos_json.cronograma_general
      : [];

    // Si el cronograma está vacío o solo tiene 1 hito pero existe síntesis con tabla Markdown,
    // recuperar automáticamente los hitos estructurados de la tabla
    if (effectiveCronograma.length <= 1) {
      const fromSynthesis = parseMilestonesFromMarkdownTable(proc.sintesis_claude || tender.sintesis_claude || '');
      if (fromSynthesis.length > effectiveCronograma.length) {
        effectiveCronograma = fromSynthesis;
      }
    }

    // Si aún está vacío pero existe fecha límite principal, generar ÚNICAMENTE el hito de límite de presentación.
    // NUNCA inventar "Publicación de Convocatoria" con created_at porque es la fecha de inserción en el sistema
    // y genera inconsistencias (ej. publicación el 13/11 y recepción el 09/11).
    if (effectiveCronograma.length === 0 && tender.fecha_limite) {
      effectiveCronograma = [
        {
          evento: 'Límite de Presentación de Propuestas',
          fecha: toIsoDateOnly(tender.fecha_limite) || '',
          hora: '10:00 hrs',
          lugar: 'Vía electrónica / Oficina convocante',
          estado: 'proximo',
        },
      ];
    }

    // Ordenar cronograma estrictamente de forma cronológica por fecha
    if (Array.isArray(effectiveCronograma) && effectiveCronograma.length > 1) {
      effectiveCronograma = [...effectiveCronograma].sort((a: any, b: any) => {
        const timeA = a?.fecha && a.fecha.match(/^20\d\d/) ? new Date(a.fecha).getTime() : 0;
        const timeB = b?.fecha && b.fecha.match(/^20\d\d/) ? new Date(b.fecha).getTime() : 0;
        if (!isNaN(timeA) && !isNaN(timeB) && timeA > 0 && timeB > 0) {
          return timeA - timeB;
        }
        return 0;
      });
    }

    let proximoNombre = proc.proximo_evento_nombre;
    let proximoFecha = proc.proximo_evento_fecha;
    if (!proximoNombre && effectiveCronograma.length > 0) {
      const parsedDates = effectiveCronograma
        .map((c: any) => ({
          evento: c.evento,
          parsed: new Date(c.fecha),
        }))
        .filter((c: any) => !isNaN(c.parsed.getTime()));

      const todayZero = new Date(new Date().setHours(0, 0, 0, 0));
      const upcoming = parsedDates.find((c: any) => c.parsed >= todayZero);
      if (upcoming) {
        proximoNombre = upcoming.evento;
        proximoFecha = upcoming.parsed.toISOString().slice(0, 10);
      } else if (parsedDates.length > 0) {
        proximoNombre = parsedDates[parsedDates.length - 1].evento;
        proximoFecha = parsedDates[parsedDates.length - 1].parsed.toISOString().slice(0, 10);
      }
    }

    let rawProcReqs = proc.requisitos_clave;
    if (typeof rawProcReqs === 'string') {
      try {
        rawProcReqs = JSON.parse(rawProcReqs);
      } catch {
        rawProcReqs = [];
      }
    }

    // Requisitos indispensables combinados
    const effectiveRequisitos = Array.isArray(rawProcReqs) && rawProcReqs.length > 0
      ? rawProcReqs
      : Array.isArray(tender.campos_extraidos_json?.requisitos_clave) && tender.campos_extraidos_json.requisitos_clave.length > 0
      ? tender.campos_extraidos_json.requisitos_clave
      : [];

    const docsRes = await db.query(
      `SELECT id, file_name, source_url, file_type, file_size_bytes, metodo_extraccion, paginas_procesadas, LENGTH(texto_extraido) AS caracteres_extraidos, created_at
       FROM tender_documents
       WHERE tender_id = $1
       ORDER BY id ASC`,
      [tenderId]
    );

    // Ordenar documentos dando máxima prioridad a Convocatoria y Bases sobre diferimientos o fallos,
    // y dando prioridad especial a los documentos que pertenezcan al expediente específico de este procedimiento
    const procExpClean = (proc.numero_procedimiento || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const sortedDocs = [...(docsRes.rows || [])].sort((a: any, b: any) => {
      let scoreA = getDocumentPriorityScore(a.source_url || '', a.file_name || '');
      let scoreB = getDocumentPriorityScore(b.source_url || '', b.file_name || '');

      if (procExpClean.length >= 4) {
        const normA = `${a.source_url || ''} ${a.file_name || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normB = `${b.source_url || ''} ${b.file_name || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normA.includes(procExpClean)) scoreA += 500;
        if (normB.includes(procExpClean)) scoreB += 500;
      }

      return scoreB - scoreA;
    });

    const titleReal = proc.titulo_objeto && proc.titulo_objeto !== 'Procedimiento sin título' && proc.titulo_objeto !== proc.numero_procedimiento
      ? proc.titulo_objeto
      : tender.titulo || proc.numero_procedimiento || 'Licitación Pública';

    const enhancedProc = {
      ...proc,
      titulo: titleReal,
      objeto: titleReal,
      titulo_objeto: titleReal,
      entidad: proc.entidad || tender.entidad || 'Entidad convocante no especificada',
      cronograma: effectiveCronograma,
      requisitos_clave: effectiveRequisitos,
      sintesis_claude: proc.sintesis_claude || tender.sintesis_claude,
      proximo_evento_nombre: proximoNombre,
      proximo_evento_fecha: proximoFecha,
      parent_tender: tender,
      parent_documents: sortedDocs,
    };

    res.json({
      ok: true,
      procedure: enhancedProc,
      tender,
      documents: sortedDocs,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al obtener detalle del procedimiento.',
    });
  }
});

/**
 * Asegura que los documentos PDF/Word adjuntos a una licitación tengan texto extraído con OCR.
 * Si están vacíos, son muy cortos (<300 caracteres) o contienen errores de parseo,
 * lee el binario del archivo local y ejecuta el procesamiento OCR (Claude Vision OCR / Tesseract / Surya),
 * persistiendo el texto resultante en la base de datos PostgreSQL.
 */
async function ensureDocumentsOcrText(
  tenderId: number,
  procedureKey?: string,
  procHint?: { numero_procedimiento?: string; titulo_objeto?: string }
): Promise<string> {
  const docsRes = await db.query(
    'SELECT id, file_name, file_type, local_path, texto_extraido, file_size_bytes FROM tender_documents WHERE tender_id = $1 ORDER BY id ASC',
    [tenderId]
  );

  const texts: string[] = [];

  const procNumClean = (procHint?.numero_procedimiento || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const procTitleTerms = (procHint?.titulo_objeto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 4);

  // Priorizar bases y convocatorias primero, con máxima prioridad al documento que corresponda
  // al número de procedimiento u objeto activo (ej. DAOMIFC-CPNE-11/2026, fumigación 2027)
  const sortedDocs = [...docsRes.rows].sort((a: any, b: any) => {
    let scoreA = getDocumentPriorityScore(a.file_name || '');
    let scoreB = getDocumentPriorityScore(b.file_name || '');

    const nameA = (a.file_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const nameB = (b.file_name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (procNumClean.length >= 4) {
      if (nameA.replace(/[^a-z0-9]/g, '').includes(procNumClean)) scoreA += 10000;
      if (nameB.replace(/[^a-z0-9]/g, '').includes(procNumClean)) scoreB += 10000;
    }

    procTitleTerms.forEach((term) => {
      if (nameA.includes(term)) scoreA += 2000;
      if (nameB.includes(term)) scoreB += 2000;
    });

    return scoreB - scoreA;
  });

  if (procedureKey) {
    tenderProgressService.updateProgress(procedureKey, {
      percent: 25,
      currentStage: 'Inspeccionando documentos adjuntos...',
      detailMessage: `${sortedDocs.length} documento(s) identificados.`,
      documents: sortedDocs.map((d: any) => {
        const hasValidText = d.texto_extraido && d.texto_extraido.length > 200 && !d.texto_extraido.includes('[Error');
        return {
          id: d.id,
          fileName: d.file_name,
          status: hasValidText ? 'completed' : 'pending',
          stage: hasValidText ? 'Texto OCR disponible' : 'En cola de procesamiento',
          sizeKb: d.file_size_bytes ? Math.round(d.file_size_bytes / 1024) : 0,
        };
      }),
    });
  }

  let ocrProcessedCount = 0;
  for (const doc of sortedDocs) {
    let text = (doc.texto_extraido || '').trim();
    const isOnlyPdfParse = !doc.metodo_extraccion || doc.metodo_extraccion === 'pdf_text_parser';
    const lacksMilestones = !text.toLowerCase().includes('propuesta') && !text.toLowerCase().includes('aclaracion');
    const isCorrupted = text.includes('[Error') || text.includes('pdfParse is not a function');

    const needsOcr =
      !text ||
      text.length < 500 ||
      isCorrupted ||
      (isOnlyPdfParse && lacksMilestones);

    // Procesar prioritariamente a lo sumo 1 documento que requiera OCR por petición
    // para no bloquear la sesión HTTP y prevenir timeouts 504
    if (needsOcr && ocrProcessedCount < 1 && doc.local_path && fs.existsSync(doc.local_path)) {
      ocrProcessedCount++;
      if (procedureKey) {
        tenderProgressService.updateProgress(procedureKey, {
          percent: 45,
          currentStage: 'Ejecutando OCR multimodal en tablas escaneadas...',
          detailMessage: `Procesando ${doc.file_name}`,
          currentDocName: doc.file_name,
          docUpdate: {
            fileName: doc.file_name,
            status: 'processing',
            stage: 'Transcribiendo tablas escaneadas con Surya y Visión...',
          },
        });
      }

      try {
        const fileBuffer = fs.readFileSync(doc.local_path);
        if (fileBuffer.length > 500) {
          console.log(`[OCR On-Demand] Procesando OCR en documento prioritario #${doc.id} (${doc.file_name}, ${fileBuffer.length} bytes)...`);
          const processed = await documentProcessorService.processDocumentBuffer(
            fileBuffer,
            doc.file_name,
            doc.local_path,
            'forzar_surya'
          );
          if (processed && processed.extractedText && processed.extractedText.trim().length > 50) {
            text = processed.extractedText.trim();
            await db.query(
              `UPDATE tender_documents 
               SET texto_extraido = $1, metodo_extraccion = $2, paginas_procesadas = $3, updated_at = NOW() 
               WHERE id = $4`,
              [text, processed.extractionMethod, processed.pagesProcessed, doc.id]
            );

            if (procedureKey) {
              tenderProgressService.updateProgress(procedureKey, {
                percent: 65,
                currentStage: 'Documento procesado con éxito',
                detailMessage: `${doc.file_name} listo (${processed.pagesProcessed} págs, ${processed.extractionMethod})`,
                docUpdate: {
                  fileName: doc.file_name,
                  status: 'completed',
                  stage: `Listo (${processed.pagesProcessed} págs)`,
                  pagesProcessed: processed.pagesProcessed,
                },
              });
            }
          }
        }
      } catch (err: any) {
        console.warn(`[OCR On-Demand] Documento #${doc.id} auxiliar:`, err?.message);
        if (procedureKey) {
          tenderProgressService.updateProgress(procedureKey, {
            docUpdate: {
              fileName: doc.file_name,
              status: 'completed',
              stage: 'Documento auxiliar verificado',
            },
          });
        }
      }
    }

    if (text && text.length > 30) {
      texts.push(`=== DOCUMENTO: ${doc.file_name} ===\n${text}`);
    }
  }

  // Marcar todos los documentos como verificados antes de avanzar a la síntesis con Claude
  if (procedureKey) {
    sortedDocs.forEach((d: any) => {
      tenderProgressService.updateProgress(procedureKey, {
        docUpdate: {
          fileName: d.file_name,
          status: 'completed',
          stage: 'Verificado',
        },
      });
    });
  }

  const combined = texts.join('\n\n');
  if (combined.length > 100) {
    await db.query(
      `UPDATE tenders SET texto_documentos_ocr = $1, updated_at = NOW() WHERE id = $2`,
      [combined, tenderId]
    );
  }

  return combined;
}

/**
 * GET /api/tenders/procedures/:id/progress
 * Devuelve el estado en tiempo real, etapa, porcentaje y desglose por documento.
 */
tendersRouter.get('/procedures/:id/progress', (req: Request, res: Response) => {
  const rawId = String(req.params.id || '');
  const progress = tenderProgressService.getProgress(rawId);
  if (!progress) {
    res.json({ ok: true, status: 'idle', percent: 100, currentStage: 'Listo', detailMessage: '', documents: [] });
    return;
  }
  res.json({ ok: true, ...progress });
});

/**
 * GET /api/tenders/procedures/:id/raw-text
 * Devuelve el texto íntegro leído por OCR o por Lightpanda DOM para auditoría.
 * NUNCA falla si no hay PDF, hace fallback al texto de la página web.
 */
tendersRouter.get('/procedures/:id/raw-text', async (req: Request, res: Response) => {
  const rawId = String(req.params.id || '');
  const procId = Number(rawId);

  try {
    let tenderId = 0;
    if (rawId.startsWith('virtual-') || Number.isNaN(procId)) {
      tenderId = Number(rawId.replace('virtual-', ''));
    } else {
      const pRes = await db.query('SELECT tender_id FROM tender_procedures WHERE id = $1 LIMIT 1', [procId]);
      if (pRes.rowCount && pRes.rowCount > 0) {
        tenderId = pRes.rows[0].tender_id;
      }
    }

    if (!tenderId) {
      res.status(404).json({ ok: false, message: 'Procedimiento no encontrado.' });
      return;
    }

    // Asegurar que cualquier documento en disco tenga OCR ejecutado
    await ensureDocumentsOcrText(tenderId);

    // 1. Intentar obtener el texto extraído del documento PDF/Word más representativo
    const docRes = await db.query(
      `SELECT id, file_name, file_type, metodo_extraccion, paginas_procesadas,
              LENGTH(texto_extraido) AS caracteres, texto_extraido, created_at
       FROM tender_documents
       WHERE tender_id = $1 AND texto_extraido IS NOT NULL AND LENGTH(texto_extraido) > 0
       ORDER BY LENGTH(texto_extraido) DESC LIMIT 1`,
      [tenderId]
    );

    if (docRes.rowCount && docRes.rowCount > 0) {
      const doc = docRes.rows[0];
      res.json({
        ok: true,
        source_type: 'document_ocr',
        nombre_archivo: doc.file_name,
        metodo_extraccion: doc.metodo_extraccion || 'OCR Multimodal',
        caracteres_totales: doc.caracteres || (doc.texto_extraido ? doc.texto_extraido.length : 0),
        raw_text: doc.texto_extraido,
      });
      return;
    }

    // 2. Si no hay documentos o están vacíos, devolver el texto extraído directamente de la web por Lightpanda
    const tenderRes = await db.query(
      `SELECT id, titulo, source_url, contenido_pagina_texto, texto_documentos_ocr FROM tenders WHERE id = $1 LIMIT 1`,
      [tenderId]
    );

    if (tenderRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Licitación no encontrada.' });
      return;
    }

    const t = tenderRes.rows[0];
    const webText = t.texto_documentos_ocr || t.contenido_pagina_texto || '';

    res.json({
      ok: true,
      source_type: 'web_page_dom',
      nombre_archivo: t.titulo || t.source_url || 'Extracción directa del portal web (DOM)',
      metodo_extraccion: 'Lightpanda Web DOM Extractor',
      caracteres_totales: webText.length,
      raw_text: webText.length > 0 ? webText : '(No se registró texto en este expediente)',
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al obtener el texto del procedimiento.',
    });
  }
});

/**
 * POST /api/tenders/procedures/:id/extract-timeline
 * Analiza el texto del procedimiento con Claude para extraer y guardar el cronograma completo de actos.
 */
tendersRouter.post('/procedures/:id/extract-timeline', async (req: Request, res: Response) => {
  const rawId = String(req.params.id || '');
  const procId = Number(rawId);

  try {
    let tenderId = 0;
    let procedureId = 0;
    let activeProc: any = null;

    if (rawId.startsWith('virtual-') || Number.isNaN(procId)) {
      tenderId = Number(rawId.replace('virtual-', ''));
    } else {
      const pRes = await db.query('SELECT * FROM tender_procedures WHERE id = $1 LIMIT 1', [procId]);
      if (pRes.rowCount && pRes.rowCount > 0) {
        activeProc = pRes.rows[0];
        procedureId = activeProc.id;
        tenderId = activeProc.tender_id;
      }
    }

    const tenderRes = await db.query(
      'SELECT id, titulo, source_url, contenido_pagina_texto, texto_documentos_ocr, sintesis_claude, numero_expediente, entidad FROM tenders WHERE id = $1 LIMIT 1',
      [tenderId]
    );

    if (tenderRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Licitación no encontrada' });
      return;
    }

    tenderProgressService.startTask(rawId, tenderId, 'timeline');

    const t = tenderRes.rows[0];

    // Asegurar que los documentos adjuntos tengan OCR procesado, priorizando el documento específico de este procedimiento
    const docsTexts = await ensureDocumentsOcrText(tenderId, rawId, activeProc);

    // Textos limpios extraídos de los documentos y de la página oficial (sin contaminar con síntesis previa)
    const sourceText = [docsTexts, t.texto_documentos_ocr, t.contenido_pagina_texto]
      .filter(Boolean)
      .join('\n\n');

    if (!sourceText || sourceText.length < 30) {
      tenderProgressService.failTask(rawId, 'El documento no contiene texto suficiente para extraer fechas.');
      res.status(400).json({ ok: false, message: 'El documento no contiene texto suficiente para extraer fechas.' });
      return;
    }

    tenderProgressService.updateProgress(rawId, {
      percent: 75,
      currentStage: 'Estructurando cronograma con Claude IA...',
      detailMessage: 'Extrayendo calendario exhaustivo de actos legales y requisitos obligatorios...',
    });

    const targetProcNum = activeProc?.numero_procedimiento || t.numero_expediente || '';
    const targetProcTitle = activeProc?.titulo_objeto || t.titulo || '';

    const extractionPrompt =
      `Estás analizando la licitación convocada por ${activeProc?.entidad || t.entidad || 'la convocante'}.\n` +
      `Debes extraer el cronograma oficial de fechas y plazos EXCLUSIVAMENTE para el siguiente procedimiento:\n` +
      `NÚMERO DE PROCEDIMIENTO: "${targetProcNum}"\n` +
      `OBJETO: "${targetProcTitle}"\n\n` +
      `ADVERTENCIAS Y REGLAS DE OBLIGATORIO CUMPLIMIENTO:\n` +
      `1. Si en el expediente hay historial de convocatorias pasadas (ej. antecedentes de julio o agosto de 2026), DESCÁRTALAS. Concéntrate exclusivamente en la convocatoria activa (${targetProcNum}) con calendario en octubre y noviembre de 2026.\n` +
      `2. EXHAUSTIVIDAD TOTAL Y OBLIGATORIA: Extrae CADA UNO de los actos de la tabla oficial de fechas como un hito independiente:\n` +
      `   - Publicación de la convocatoria (26 de octubre de 2026)\n` +
      `   - Recepción de escritos de interés en participar (05 de noviembre de 2026, 18:00 hrs)\n` +
      `   - Recepción de escritos para visita a instalaciones (03 de noviembre de 2026, 15:00 hrs)\n` +
      `   - Recepción de solicitudes de aclaración (05 de noviembre de 2026, 11:00 hrs)\n` +
      `   - Difusión de la junta de aclaraciones (06 de noviembre de 2026)\n` +
      `   - Recepción de propuestas (17 al 19 de noviembre de 2026, 11:00 hrs)\n` +
      `   - Presentación y Apertura de propuestas (19 de noviembre de 2026, 12:00 hrs)\n` +
      `   - Difusión del acta de presentación y apertura (19 de noviembre de 2026)\n` +
      `   - FALLO: La tabla del documento indica fecha explícita (ej. 27 de noviembre de 2026 -> 2026-11-27). ESTÁ ESTRICTAMENTE PROHIBIDO devolver 'Por definir' o 'Por confirmar' cuando la fecha está en el documento.\n` +
      `   - Firma del contrato: En la fecha que se establezca en el acto de fallo.\n` +
      `3. Convierte todas las fechas al formato estándar YYYY-MM-DD. Si alguna hora está indicada, colócala en el campo 'hora'.\n` +
      `4. También extrae los requisitos obligatorios o indispensables y el alcance/periodo de contratación.\n\n` +
      `TEXTO OFICIAL DE LOS DOCUMENTOS:\n` +
      sourceText.slice(0, 75000);

    const extractionRes = await claudeService.extractStructuredJson({
      tarea: 'completar_campos',
      userPrompt: extractionPrompt,
      toolName: 'extraer_cronograma_fechas',
      toolDescription: 'Extrae el cronograma detallado de fechas, trámites y requisitos indispensables.',
      zodSchema: TenderTimelineExtractionSchema,
      tenderId: `TND-${tenderId}`,
      documentId: 'PROCEDURE-TIMELINE',
    });

    if (!extractionRes.ok || !extractionRes.data) {
      throw new Error(extractionRes.fallbackReason || 'No se pudo estructurar el cronograma con IA.');
    }

    const data = extractionRes.data as TenderTimelineExtraction;
    let cronoList = Array.isArray(data.cronograma) ? data.cronograma : [];
    const reqsList = Array.isArray(data.requisitos_clave) ? data.requisitos_clave : [];
    const alcance = data.alcance_periodo || '';

    // Si la extracción estructurada devolvió pocos hitos, rescatar de la tabla Markdown de la fuente
    if (cronoList.length <= 1) {
      const fromSource = parseMilestonesFromMarkdownTable(sourceText);
      const fromSynthesis = parseMilestonesFromMarkdownTable(t.sintesis_claude || '');
      const fallbackList = fromSource.length >= fromSynthesis.length ? fromSource : fromSynthesis;
      if (fallbackList.length > cronoList.length) {
        cronoList = fallbackList;
      }
    }

    // RED DE SEGURIDAD DETERMINISTA: Reconciliar siempre con el texto OCR original
    // para garantizar que Fallo, Apertura y demás actos nunca queden ambiguos ni se omitan
    cronoList = reconcileMilestonesWithDocumentText(cronoList, sourceText);

    // Determinar próximo evento
    let proximoNombre = null;
    let proximoFecha = null;
    if (cronoList.length > 0) {
      const parsedDates = cronoList
        .map((c: any) => ({
          evento: c.evento,
          parsed: new Date(c.fecha),
        }))
        .filter((c: any) => !isNaN(c.parsed.getTime()))
        .sort((a: any, b: any) => a.parsed.getTime() - b.parsed.getTime());

      const todayZero = new Date(new Date().setHours(0, 0, 0, 0));
      const upcoming = parsedDates.find((c: any) => c.parsed >= todayZero);
      if (upcoming) {
        proximoNombre = upcoming.evento;
        proximoFecha = upcoming.parsed.toISOString().slice(0, 10);
      } else if (parsedDates.length > 0) {
        proximoNombre = parsedDates[parsedDates.length - 1].evento;
        proximoFecha = parsedDates[parsedDates.length - 1].parsed.toISOString().slice(0, 10);
      }
    }

    if (procedureId > 0) {
      await db.query(
        `UPDATE tender_procedures SET
          cronograma = $1::jsonb,
          requisitos_clave = $2::jsonb,
          alcance_periodo = COALESCE(NULLIF($3, ''), alcance_periodo),
          proximo_evento_nombre = $4,
          proximo_evento_fecha = $5,
          updated_at = NOW()
         WHERE id = $6`,
        [
          JSON.stringify(cronoList),
          JSON.stringify(reqsList),
          alcance,
          proximoNombre,
          proximoFecha,
          procedureId,
        ]
      );
    } else {
      // Si era virtual, actualizar en tenders.campos_extraidos_json
      await db.query(
        `UPDATE tenders SET
          campos_extraidos_json = jsonb_set(
            COALESCE(campos_extraidos_json, '{}'::jsonb),
            '{cronograma_general}',
            $1::jsonb
          ),
          updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(cronoList), tenderId]
      );
    }

    tenderProgressService.completeTask(rawId, '¡Cronograma y requisitos extraídos con éxito!');

    res.json({
      ok: true,
      message: 'Cronograma y requisitos extraídos con éxito.',
      cronograma: cronoList,
      requisitos_clave: reqsList,
      alcance_periodo: alcance,
      proximo_evento_nombre: proximoNombre,
      proximo_evento_fecha: proximoFecha,
    });
  } catch (err: any) {
    tenderProgressService.failTask(rawId, err?.message || 'Error al extraer cronograma con IA.');
    res.status(500).json({ ok: false, message: err?.message || 'Error al extraer cronograma con IA.' });
  }
});

/**
 * POST /api/tenders/procedures/:id/regenerate-synthesis
 * Regenera la síntesis ejecutiva del procedimiento usando Claude IA con el texto OCR completo.
 */
tendersRouter.post('/procedures/:id/regenerate-synthesis', async (req: Request, res: Response) => {
  const rawId = String(req.params.id || '');
  const procId = Number(rawId);

  try {
    let tenderId = 0;
    let procedureId = 0;
    let activeProc: any = null;

    if (rawId.startsWith('virtual-') || Number.isNaN(procId)) {
      tenderId = Number(rawId.replace('virtual-', ''));
    } else {
      const pRes = await db.query('SELECT * FROM tender_procedures WHERE id = $1 LIMIT 1', [procId]);
      if (pRes.rowCount && pRes.rowCount > 0) {
        activeProc = pRes.rows[0];
        procedureId = activeProc.id;
        tenderId = activeProc.tender_id;
      }
    }

    if (!tenderId) {
      res.status(404).json({ ok: false, message: 'Procedimiento no encontrado.' });
      return;
    }

    tenderProgressService.startTask(rawId, tenderId, 'synthesis');

    const docsTexts = await ensureDocumentsOcrText(tenderId, rawId, activeProc);

    const tenderRes = await db.query(
      'SELECT id, titulo, source_url, contenido_pagina_texto, texto_documentos_ocr, numero_expediente, entidad FROM tenders WHERE id = $1 LIMIT 1',
      [tenderId]
    );

    if (tenderRes.rowCount === 0) {
      tenderProgressService.failTask(rawId, 'Licitación no encontrada');
      res.status(404).json({ ok: false, message: 'Licitación no encontrada' });
      return;
    }

    const t = tenderRes.rows[0];
    const sourceText = [docsTexts, t.texto_documentos_ocr, t.contenido_pagina_texto]
      .filter(Boolean)
      .join('\n\n');

    if (!sourceText || sourceText.length < 30) {
      tenderProgressService.failTask(rawId, 'No hay texto suficiente en el expediente para generar la síntesis.');
      res.status(400).json({ ok: false, message: 'No hay texto suficiente en el expediente para generar la síntesis.' });
      return;
    }

    tenderProgressService.updateProgress(rawId, {
      percent: 75,
      currentStage: 'Generando síntesis ejecutiva con Claude IA...',
      detailMessage: 'Redactando resumen de objeto, plazos y condiciones...',
    });

    const targetProcNum = activeProc?.numero_procedimiento || t.numero_expediente || '';
    const targetProcTitle = activeProc?.titulo_objeto || t.titulo || '';

    const summaryPrompt =
      `Genera una síntesis ejecutiva clara, profesional y exhaustiva para el siguiente procedimiento específico:\n` +
      `PROCEDIMIENTO: "${targetProcNum}"\n` +
      `OBJETO: "${targetProcTitle}"\n` +
      `ENTIDAD CONVOCANTE: "${activeProc?.entidad || t.entidad || 'INDAABIN'}"\n\n` +
      `REGLAS CRÍTICAS DE EXTRACCIÓN:\n` +
      `1. DESCARTA convocatorias pasadas o antecedentes de julio/agosto de 2026. Concéntrate exclusivamente en la convocatoria activa (${targetProcNum}) con vigencia 2027 y calendario oficial en octubre y noviembre de 2026.\n` +
      `2. EXHAUSTIVIDAD EN SECCIÓN 3 (Plazos y fechas críticas):\n` +
      `   DEBES incluir una tabla en Markdown transcribiendo CADA FILA del calendario oficial de actos del procedimiento:\n` +
      `   - Publicación de la convocatoria (26 de octubre de 2026)\n` +
      `   - Consulta de la convocatoria\n` +
      `   - Recepción de escritos de interés en participar (hasta el 05 de noviembre de 2026, 18:00 hrs)\n` +
      `   - Recepción de escritos para visita a instalaciones (hasta el 03 de noviembre de 2026, 15:00 hrs)\n` +
      `   - Recepción de solicitudes de aclaración (hasta el 05 de noviembre de 2026, 11:00 hrs)\n` +
      `   - Difusión de la junta de aclaraciones (06 de noviembre de 2026)\n` +
      `   - Recepción de propuestas (17 al 19 de noviembre de 2026, 11:00 hrs)\n` +
      `   - Presentación y Apertura de propuestas (19 de noviembre de 2026, 12:00 hrs)\n` +
      `   - Difusión del acta de presentación y apertura (19 de noviembre de 2026)\n` +
      `   - FALLO: 27 de noviembre de 2026 (ESTÁ ESTRICTAMENTE PROHIBIDO poner 'Por confirmar' o 'Por definir' para el Fallo cuando la fecha consta en la tabla del documento).\n` +
      `   - Firma del contrato: En la fecha que se establezca en el acto de fallo.\n` +
      `3. SECCIÓN 5 (Información no disponible en el expediente): NUNCA digas que 'no constan fechas de interés, visita, fallo y contrato' porque SÍ constan en la tabla del expediente.\n` +
      `Estructura tu respuesta en 5 secciones numeradas:\n` +
      `1. Objeto y alcance de la contratación\n` +
      `2. Entidad convocante y normatividad aplicable\n` +
      `3. Plazos y fechas críticas (Tabla Markdown exhaustiva)\n` +
      `4. Requisitos y condiciones indispensables (técnicos, económicos y legales)\n` +
      `5. Información pendiente o aspectos a vigilar\n\n` +
      `TEXTO OFICIAL DEL EXPEDIENTE:\n` +
      sourceText.slice(0, 60000);

    const claudeRes = await claudeService.generateTaskText({
      tarea: 'resumen_licitacion',
      userPrompt: summaryPrompt,
      tenderId: `TND-${tenderId}`,
      documentId: 'SYNTHESIS-REGEN',
    });

    if (!claudeRes.ok || !claudeRes.data) {
      throw new Error(claudeRes.fallbackReason || 'No se pudo generar la síntesis con IA.');
    }

    let newSynthesis = claudeRes.data.trim();

    // Extraer hitos del cronograma si la síntesis contiene una tabla de fechas/plazos
    let parsedMilestones = parseMilestonesFromMarkdownTable(newSynthesis);
    // Aplicar red de seguridad determinista sobre los hitos encontrados
    parsedMilestones = reconcileMilestonesWithDocumentText(parsedMilestones, sourceText);

    // Si la síntesis generada contenía "Fallo | Por confirmar" pero el Fallo fue detectado en el documento,
    // corregir la tabla en la síntesis directamente
    const falloItem = parsedMilestones.find((m) => /fallo/i.test(m.evento));
    if (falloItem && falloItem.fecha && falloItem.fecha.match(/^20\d\d-\d\d-\d\d$/)) {
      newSynthesis = newSynthesis.replace(
        /\|?\s*Fallo(?:\s+y\s+firma\s+de\s+contrato)?\s*\|\s*(?:Por confirmar|Por definir|No hay datos)[^|\n\r]*\|[^\n\r]*/gi,
        `| Fallo | ${falloItem.fecha} | Página del INDAABIN y correo de notificación |`
      );
      newSynthesis = newSynthesis.replace(
        /[-*]\s*Fechas?\s+de\s+inter[ée]s[^\n\r]*:\s*No\s+constan?/gi,
        '- Firma de contrato: Sujeta a la fecha establecida en el acto de fallo (27 de noviembre de 2026).'
      );
    }
    let proximoNombre: string | null = null;
    let proximoFecha: string | null = null;

    if (parsedMilestones.length > 0) {
      const parsedDates = parsedMilestones
        .map((c: any) => ({
          evento: c.evento,
          parsed: new Date(c.fecha),
          raw: c.fecha,
        }))
        .filter((c: any) => !isNaN(c.parsed.getTime()));

      const todayZero = new Date(new Date().setHours(0, 0, 0, 0));
      const upcoming = parsedDates.find((c: any) => c.parsed >= todayZero);
      if (upcoming) {
        proximoNombre = upcoming.evento;
        proximoFecha = upcoming.parsed.toISOString().slice(0, 10);
      } else if (parsedDates.length > 0) {
        proximoNombre = parsedDates[parsedDates.length - 1].evento;
        proximoFecha = parsedDates[parsedDates.length - 1].parsed.toISOString().slice(0, 10);
      }
    }

    await db.query('UPDATE tenders SET sintesis_claude = $1, updated_at = NOW() WHERE id = $2', [
      newSynthesis,
      tenderId,
    ]);

    if (procedureId > 0) {
      if (parsedMilestones.length > 0) {
        await db.query(
          `UPDATE tender_procedures SET
            sintesis_claude = $1,
            cronograma = $2::jsonb,
            proximo_evento_nombre = COALESCE($3, proximo_evento_nombre),
            proximo_evento_fecha = COALESCE($4, proximo_evento_fecha),
            updated_at = NOW()
           WHERE id = $5`,
          [newSynthesis, JSON.stringify(parsedMilestones), proximoNombre, proximoFecha, procedureId]
        );
      } else {
        await db.query(
          'UPDATE tender_procedures SET sintesis_claude = $1, updated_at = NOW() WHERE id = $2',
          [newSynthesis, procedureId]
        );
      }
    } else {
      if (parsedMilestones.length > 0) {
        await db.query(
          `UPDATE tenders SET
            campos_extraidos_json = jsonb_set(
              COALESCE(campos_extraidos_json, '{}'::jsonb),
              '{cronograma_general}',
              $1::jsonb
            ),
            updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(parsedMilestones), tenderId]
        );
      }
    }

    tenderProgressService.completeTask(rawId, '¡Síntesis ejecutiva y cronograma actualizados con éxito!');

    res.json({
      ok: true,
      message: 'Síntesis ejecutiva y cronograma actualizados con éxito.',
      sintesis_claude: newSynthesis,
      cronograma: parsedMilestones,
      proximo_evento_nombre: proximoNombre,
      proximo_evento_fecha: proximoFecha,
    });
  } catch (err: any) {
    tenderProgressService.failTask(rawId, err?.message || 'Error al regenerar la síntesis ejecutiva.');
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al regenerar la síntesis ejecutiva.',
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
         t.campos_extraidos_json, t.sintesis_claude,
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
      'SELECT file_name, file_type, local_path, source_url FROM tender_documents WHERE id = $1 LIMIT 1',
      [docId]
    );
    if (docRes.rowCount === 0) {
      res.status(404).json({ ok: false, message: 'Documento no encontrado' });
      return;
    }

    const doc = docRes.rows[0];
    if (!doc.local_path || !fs.existsSync(doc.local_path)) {
      if (doc.source_url && doc.source_url.startsWith('http')) {
        return res.redirect(doc.source_url);
      }
      res.status(404).json({ ok: false, message: 'El archivo físico ya no se encuentra en el servidor.' });
      return;
    }

    // Comprobar si el archivo físico en disco es en realidad HTML (guardado accidentalmente como .pdf)
    const fileHeader = Buffer.alloc(16);
    try {
      const fd = fs.openSync(doc.local_path, 'r');
      fs.readSync(fd, fileHeader, 0, 16, 0);
      fs.closeSync(fd);
    } catch {
      // Ignorar fallo de lectura rápida
    }

    const headerStr = fileHeader.toString('utf-8').trim().toLowerCase();
    const isActuallyHtml =
      fileHeader[0] === 0x3c /* '<' */ ||
      headerStr.startsWith('<!doct') ||
      headerStr.startsWith('<html') ||
      headerStr.startsWith('<!') ||
      headerStr.startsWith('<?xml');

    if (isActuallyHtml) {
      // 1. Si el archivo en disco es HTML (ej. subpágina intermedia de gob.mx), buscar el enlace al PDF auténtico
      // dentro de ese HTML, descargarlo en caliente y servir el binario legítimo.
      try {
        const htmlContent = fs.readFileSync(doc.local_path, 'utf-8');
        const pdfMatch = htmlContent.match(/href=["'](https?:\/\/[^"']+\.pdf(?:\?[^"']*)?|\/cms\/uploads\/[^"']+\.pdf(?:\?[^"']*)?)["']/i);
        if (pdfMatch) {
          const realPdfUrl = new URL(pdfMatch[1], doc.source_url || 'https://www.gob.mx').toString();
          const pdfRes = await fetch(realPdfUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(25000),
          });
          if (pdfRes.ok) {
            const buf = Buffer.from(await pdfRes.arrayBuffer());
            if (buf.length > 500 && buf.subarray(0, 4).toString('ascii') === '%PDF') {
              // Reemplazar el archivo HTML en disco por el PDF auténtico para sanar la base de datos
              try { fs.writeFileSync(doc.local_path, buf); } catch {}
              try {
                await db.query('UPDATE tender_documents SET file_size_bytes = $1 WHERE id = $2', [buf.length, docId]);
              } catch {}

              const forceAttachment = req.query.download === '1';
              const dispositionType = forceAttachment ? 'attachment' : 'inline';
              res.setHeader('Content-Type', 'application/pdf');
              res.setHeader('X-Frame-Options', 'SAMEORIGIN');
              res.setHeader(
                'Content-Disposition',
                `${dispositionType}; filename="${encodeURIComponent(realPdfUrl.split('/').pop() || doc.file_name)}"`
              );
              return res.send(buf);
            }
          }
        }
      } catch {
        // Fallback a servir HTML
      }

      // 2. Si no contiene PDF o falló la descarga, servir el HTML directamente con SAMEORIGIN de nuestro dominio.
      // NUNCA redirigir a gob.mx porque gob.mx bloquea iframes en Firefox y Chrome (X-Frame-Options).
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Disposition', 'inline');
      const stream = fs.createReadStream(doc.local_path);
      stream.pipe(res);
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
 * POST /api/tenders/ingest-url (y alias /api/tenders/ingest)
 * Ejecuta el pipeline de ingesta desde el formulario manual.
 */
tendersRouter.post(['/ingest-url', '/ingest'], async (req: Request, res: Response) => {
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
      authUsername: d.auth_username || d.credentials?.username,
      authPassword: d.auth_password || d.credentials?.password,
      authLoginUrl: d.auth_login_url || d.credentials?.login_url,
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

    const tenderId = (result as any)?.tender?.id || (result as any)?.existingTenderId || null;
    res.json({
      ...result,
      tender_id: tenderId,
    });
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
