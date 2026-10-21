import { Router, Response } from 'express';
import { db } from '../../db/pool.js';
import { AuthenticatedRequest, requireAdminRole } from '../../middlewares/auth.middleware.js';
import {
  UpdateLlmSettingsSchema,
  TestLlmConnectionSchema,
  UpdateTaskProfilesSchema,
  UpdateModelPricingSchema,
  UsageQuerySchema,
  TaskNameSchema,
  TenderExtractionSchema,
} from './llm.schemas.js';
import { encryptApiKey, formatMaskedApiKey } from './crypto.service.js';
import { llmConfigCache } from './config.cache.js';
import { getBudgetStatus } from './budget.service.js';
import { claudeService } from './claude.service.js';
import { syncModelsFromAnthropicApi } from './models.sync.js';

export const llmSettingsRouter = Router();
export const llmPublicRouter = Router();

// Aplicar protección de rol admin a todos los endpoints de /api/settings/llm
llmSettingsRouter.use(requireAdminRole);

/**
 * GET /api/settings/llm
 * Devuelve configuración activa (con clave enmascarada sk-ant-…XXXX, jamás en claro),
 * catálogo de modelos, perfiles, estado del presupuesto e historial reciente.
 */
llmSettingsRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await llmConfigCache.getPublicAdminSettings();
    const budget = await getBudgetStatus();
    const historyRes = await db.query(
      `SELECT id, fecha, entidad, accion, usuario, version_resultante, campos_modificados
       FROM llm_settings_history
       ORDER BY fecha DESC
       LIMIT 30`
    );

    res.json({
      ok: true,
      ...data,
      budget,
      history: historyRes.rows,
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      message: err?.message || 'Error al obtener la configuración de LLM.',
    });
  }
});

/**
 * PUT /api/settings/llm
 * Valida con Zod, cifra nueva API key si se envía, valida max_tokens contra max_output_tokens del modelo,
 * guarda auditoría en llm_settings_history e invalida caché en memoria vía NOTIFY.
 */
llmSettingsRouter.put('/', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = UpdateLlmSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      issues: parsed.error.issues,
    });
    return;
  }

  const input = parsed.data;
  const snap = await llmConfigCache.getSnapshot(true);
  const current = snap.settings;
  const usuario = req.user?.username || 'admin';

  // Validar max_tokens contra el max_output_tokens del modelo elegido en llm_models
  const chosenModel = snap.modelsMap[input.default_model];
  if (chosenModel && input.max_tokens > chosenModel.max_output_tokens) {
    res.status(400).json({
      ok: false,
      error: 'MAX_TOKENS_EXCEEDS_MODEL_LIMIT',
      message: `El valor de max_tokens (${input.max_tokens}) supera el límite máximo de salida del modelo "${chosenModel.nombre_visible}" (${chosenModel.max_output_tokens} tokens).`,
    });
    return;
  }

  let newEncryptedKey = current.api_key_encrypted;
  let newLast4 = current.api_key_last4;
  let keyAction: 'unchanged' | 'replaced' | 'deleted' = 'unchanged';

  if (input.remove_api_key) {
    newEncryptedKey = null;
    newLast4 = null;
    keyAction = 'deleted';
  } else if (input.api_key && input.api_key.trim().length > 0 && !input.api_key.includes('…')) {
    const enc = encryptApiKey(input.api_key);
    newEncryptedKey = enc.encrypted;
    newLast4 = enc.last4;
    keyAction = 'replaced';
  }

  // Calcular diff de auditoría (nunca guardar la clave en claro)
  const diff: Record<string, { antes: any; despues: any }> = {};
  const fieldsToCompare: Array<keyof typeof input> = [
    'activo',
    'api_base_url',
    'anthropic_version',
    'default_model',
    'max_tokens',
    'temperature',
    'top_p',
    'timeout_ms',
    'max_retries',
    'max_input_chars',
    'limite_tokens_diario',
    'limite_costo_mensual',
    'accion_limite',
  ];

  for (const field of fieldsToCompare) {
    const oldVal = (current as any)[field] ?? null;
    const newVal = (input as any)[field] ?? null;
    if (String(oldVal) !== String(newVal)) {
      diff[field] = { antes: oldVal, despues: newVal };
    }
  }

  if (keyAction === 'replaced') {
    diff['api_key'] = {
      antes: formatMaskedApiKey(current.api_key_last4) || '[SIN CLAVE]',
      despues: `${formatMaskedApiKey(newLast4)} [CIFRADA AES-256-GCM]`,
    };
  } else if (keyAction === 'deleted') {
    diff['api_key'] = {
      antes: formatMaskedApiKey(current.api_key_last4) || '[CIFRADA]',
      despues: '[ELIMINADA]',
    };
  }

  const nextVersion = current.version + 1;

  await db.query(
    `UPDATE llm_settings SET
      activo = $1,
      version = $2,
      api_key_encrypted = $3,
      api_key_last4 = $4,
      api_base_url = $5,
      anthropic_version = $6,
      default_model = $7,
      max_tokens = $8,
      temperature = $9,
      top_p = $10,
      timeout_ms = $11,
      max_retries = $12,
      max_input_chars = $13,
      limite_tokens_diario = $14,
      limite_costo_mensual = $15,
      accion_limite = $16,
      updated_by = $17,
      updated_at = NOW()
     WHERE id = $18`,
    [
      input.activo,
      nextVersion,
      newEncryptedKey,
      newLast4,
      input.api_base_url,
      input.anthropic_version,
      input.default_model,
      input.max_tokens,
      input.temperature,
      input.top_p,
      input.timeout_ms,
      input.max_retries,
      input.max_input_chars,
      input.limite_tokens_diario,
      input.limite_costo_mensual,
      input.accion_limite,
      usuario,
      current.id,
    ]
  );

  const historyAction =
    keyAction === 'replaced'
      ? 'replace_api_key'
      : keyAction === 'deleted'
        ? 'delete_api_key'
        : 'update_settings';

  await db.query(
    `INSERT INTO llm_settings_history (entidad, accion, usuario, version_resultante, campos_modificados)
     VALUES ('llm_settings', $1, $2, $3, $4::jsonb)`,
    [historyAction, usuario, nextVersion, JSON.stringify(diff)]
  );

  // Invalidar caché en memoria y emitir NOTIFY para que API y Worker actualicen al instante
  await llmConfigCache.invalidateAndNotify('settings_updated', {
    version: nextVersion,
    default_model: input.default_model,
    max_tokens: input.max_tokens,
    activo: input.activo,
  });

  const updated = await llmConfigCache.getPublicAdminSettings();
  const budget = await getBudgetStatus();

  res.json({
    ok: true,
    message: `Configuración guardada (v${nextVersion}) y aplicada en memoria sin reiniciar servicios.`,
    ...updated,
    budget,
  });
});

/**
 * POST /api/settings/llm/test
 * Hace una llamada mínima con la configuración del formulario (aunque aún no esté guardada)
 * y muestra modelo, latencia, tokens usados o el error traducido.
 */
llmSettingsRouter.post('/test', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = TestLlmConnectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error_code: 'VALIDATION_ERROR',
      error_message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }

  const result = await claudeService.testConnection(parsed.data);
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * POST /api/settings/llm/models/sync
 * Consulta GET /v1/models de la API de Anthropic y actualiza la lista disponible en llm_models.
 */
llmSettingsRouter.post('/models/sync', async (req: AuthenticatedRequest, res: Response) => {
  const overrideKey = typeof req.body?.api_key === 'string' ? req.body.api_key : null;
  const usuario = req.user?.username || 'admin';

  const result = await syncModelsFromAnthropicApi(overrideKey, usuario);
  res.status(result.ok ? 200 : 400).json(result);
});

/**
 * PUT /api/settings/llm/models
 * Permite editar precios por millón de tokens de entrada/salida, ventana de contexto y disponibilidad.
 */
llmSettingsRouter.put('/models', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = UpdateModelPricingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }

  const usuario = req.user?.username || 'admin';
  for (const m of parsed.data.models) {
    await db.query(
      `UPDATE llm_models SET
        nombre_visible = COALESCE($1, nombre_visible),
        max_output_tokens = COALESCE($2, max_output_tokens),
        ventana_contexto = COALESCE($3, ventana_contexto),
        precio_entrada_mtok = $4,
        precio_salida_mtok = $5,
        disponible = $6,
        personalizado_precios = true,
        updated_at = NOW()
       WHERE model_id = $7`,
      [
        m.nombre_visible || null,
        m.max_output_tokens || null,
        m.ventana_contexto || null,
        m.precio_entrada_mtok,
        m.precio_salida_mtok,
        m.disponible,
        m.model_id,
      ]
    );
  }

  await db.query(
    `INSERT INTO llm_settings_history (entidad, accion, usuario, campos_modificados)
     VALUES ('llm_models', 'update_pricing', $1, $2::jsonb)`,
    [usuario, JSON.stringify({ modelos_actualizados: parsed.data.models.length })]
  );

  await llmConfigCache.invalidateAndNotify('models_pricing_updated');
  const snap = await llmConfigCache.getSnapshot(true);

  res.json({
    ok: true,
    message: 'Catálogo de modelos y precios actualizado correctamente.',
    models: snap.models,
  });
});

/**
 * GET /api/settings/llm/profiles
 * Devuelve los perfiles por tarea junto con su configuración efectiva heredada.
 */
llmSettingsRouter.get('/profiles', async (_req: AuthenticatedRequest, res: Response) => {
  const snap = await llmConfigCache.getSnapshot();
  const tasks = ['completar_campos', 'resumen_licitacion', 'analisis', 'constructor_recetas'] as const;

  const profilesWithEffective = await Promise.all(
    tasks.map(async (t) => {
      const raw = snap.profiles[t];
      const effective = await llmConfigCache.getEffectiveTaskConfig(t);
      return {
        ...raw,
        effective: {
          model: effective.model,
          max_tokens: effective.maxTokens,
          temperature: effective.temperature,
          inherits_model: !raw?.model,
          inherits_max_tokens: raw?.max_tokens === null || raw?.max_tokens === undefined,
          inherits_temperature: raw?.temperature === null || raw?.temperature === undefined,
        },
      };
    })
  );

  res.json({
    ok: true,
    defaults: {
      default_model: snap.settings.default_model,
      max_tokens: snap.settings.max_tokens,
      temperature: snap.settings.temperature,
    },
    profiles: profilesWithEffective,
  });
});

/**
 * PUT /api/settings/llm/profiles
 * Actualiza los perfiles por tarea en llm_task_profiles e invalida la caché vía NOTIFY.
 */
llmSettingsRouter.put('/profiles', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = UpdateTaskProfilesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      issues: parsed.error.issues,
    });
    return;
  }

  const snap = await llmConfigCache.getSnapshot(true);
  const usuario = req.user?.username || 'admin';
  const changes: Record<string, any> = {};

  for (const p of parsed.data.profiles) {
    const targetModelId = p.model || snap.settings.default_model;
    const modelSpec = snap.modelsMap[targetModelId];
    if (p.max_tokens && modelSpec && p.max_tokens > modelSpec.max_output_tokens) {
      res.status(400).json({
        ok: false,
        error: 'PROFILE_MAX_TOKENS_EXCEEDED',
        message: `En la tarea "${p.tarea}", max_tokens (${p.max_tokens}) supera el límite del modelo "${modelSpec.nombre_visible}" (${modelSpec.max_output_tokens}).`,
      });
      return;
    }

    await db.query(
      `UPDATE llm_task_profiles SET
        model = $1,
        max_tokens = $2,
        temperature = $3,
        system_prompt = $4,
        activo = $5,
        updated_by = $6,
        updated_at = NOW()
       WHERE tarea = $7`,
      [p.model, p.max_tokens, p.temperature, p.system_prompt, p.activo, usuario, p.tarea]
    );

    changes[p.tarea] = {
      model: p.model || '(hereda default)',
      max_tokens: p.max_tokens ?? '(hereda default)',
      temperature: p.temperature ?? '(hereda default)',
      activo: p.activo,
    };
  }

  await db.query(
    `INSERT INTO llm_settings_history (entidad, accion, usuario, version_resultante, campos_modificados)
     VALUES ('llm_task_profiles', 'update_profiles', $1, $2, $3::jsonb)`,
    [usuario, snap.settings.version, JSON.stringify(changes)]
  );

  await llmConfigCache.invalidateAndNotify('profiles_updated', { tasks: Object.keys(changes) });
  const updatedSnap = await llmConfigCache.getSnapshot(true);

  res.json({
    ok: true,
    message: 'Perfiles por tarea actualizados y sincronizados en memoria.',
    profiles: Object.values(updatedSnap.profiles),
  });
});

/**
 * GET /api/settings/llm/usage
 * Panel de consumo: tokens y costo por día, por tarea y por modelo (gráfica + tabla), con exportación a CSV.
 */
llmSettingsRouter.get('/usage', async (req: AuthenticatedRequest, res: Response) => {
  const parsed = UsageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }

  const { from, to, tarea, modelo, format, limit } = parsed.data;
  const conditions: string[] = [];
  const params: any[] = [];

  if (from) {
    params.push(from);
    conditions.push(`fecha >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(to);
    conditions.push(`fecha <= $${params.length}::timestamptz`);
  }
  if (tarea && tarea !== 'all') {
    params.push(tarea);
    conditions.push(`tarea = $${params.length}`);
  }
  if (modelo && modelo !== 'all') {
    params.push(modelo);
    conditions.push(`modelo = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const byDayRes = await db.query(
    `SELECT
       to_char(date_trunc('day', fecha), 'YYYY-MM-DD') AS dia,
       COUNT(*)::int AS llamadas,
       SUM(CASE WHEN exito THEN 1 ELSE 0 END)::int AS exitosas,
       SUM(tokens_entrada)::bigint AS tokens_entrada,
       SUM(tokens_salida)::bigint AS tokens_salida,
       SUM(tokens_cache_creacion + tokens_cache_lectura)::bigint AS tokens_cache,
       SUM(tokens_entrada + tokens_salida + tokens_cache_creacion + tokens_cache_lectura)::bigint AS total_tokens,
       ROUND(SUM(costo_estimado)::numeric, 6) AS costo_total,
       ROUND(AVG(latencia_ms)::numeric, 0) AS latencia_promedio_ms
     FROM llm_usage
     ${whereClause}
     GROUP BY date_trunc('day', fecha)
     ORDER BY dia ASC`,
    params
  );

  const byTaskRes = await db.query(
    `SELECT
       tarea,
       COUNT(*)::int AS llamadas,
       SUM(CASE WHEN exito THEN 1 ELSE 0 END)::int AS exitosas,
       SUM(tokens_entrada)::bigint AS tokens_entrada,
       SUM(tokens_salida)::bigint AS tokens_salida,
       SUM(tokens_cache_creacion + tokens_cache_lectura)::bigint AS tokens_cache,
       ROUND(SUM(costo_estimado)::numeric, 6) AS costo_total,
       ROUND(AVG(latencia_ms)::numeric, 0) AS latencia_promedio_ms
     FROM llm_usage
     ${whereClause}
     GROUP BY tarea
     ORDER BY costo_total DESC`,
    params
  );

  const byModelRes = await db.query(
    `SELECT
       modelo,
       COUNT(*)::int AS llamadas,
       SUM(CASE WHEN exito THEN 1 ELSE 0 END)::int AS exitosas,
       SUM(tokens_entrada)::bigint AS tokens_entrada,
       SUM(tokens_salida)::bigint AS tokens_salida,
       SUM(tokens_cache_creacion + tokens_cache_lectura)::bigint AS tokens_cache,
       ROUND(SUM(costo_estimado)::numeric, 6) AS costo_total,
       ROUND(AVG(latencia_ms)::numeric, 0) AS latencia_promedio_ms
     FROM llm_usage
     ${whereClause}
     GROUP BY modelo
     ORDER BY costo_total DESC`,
    params
  );

  const logsParams = [...params, limit];
  const recentLogsRes = await db.query(
    `SELECT
       id, fecha, tarea, modelo,
       tokens_entrada, tokens_salida,
       tokens_cache_creacion, tokens_cache_lectura,
       costo_estimado, latencia_ms, exito,
       codigo_error, mensaje_error, tender_id, document_id
     FROM llm_usage
     ${whereClause}
     ORDER BY fecha DESC
     LIMIT $${logsParams.length}`,
    logsParams
  );

  if (format === 'csv') {
    const headers = [
      'id',
      'fecha',
      'tarea',
      'modelo',
      'tokens_entrada',
      'tokens_salida',
      'tokens_cache_creacion',
      'tokens_cache_lectura',
      'costo_estimado_usd',
      'latencia_ms',
      'exito',
      'codigo_error',
      'tender_id',
      'document_id',
    ];
    const csvRows = [headers.join(',')];
    for (const r of recentLogsRes.rows) {
      csvRows.push(
        [
          r.id,
          new Date(r.fecha).toISOString(),
          `"${String(r.tarea || '').replace(/"/g, '""')}"`,
          `"${String(r.modelo || '').replace(/"/g, '""')}"`,
          r.tokens_entrada,
          r.tokens_salida,
          r.tokens_cache_creacion,
          r.tokens_cache_lectura,
          r.costo_estimado,
          r.latencia_ms,
          r.exito,
          `"${String(r.codigo_error || '').replace(/"/g, '""')}"`,
          `"${String(r.tender_id || '').replace(/"/g, '""')}"`,
          `"${String(r.document_id || '').replace(/"/g, '""')}"`,
        ].join(',')
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="llm_usage_export.csv"');
    res.send(csvRows.join('\n'));
    return;
  }

  const budget = await getBudgetStatus();

  res.json({
    ok: true,
    budget,
    by_day: byDayRes.rows,
    by_task: byTaskRes.rows,
    by_model: byModelRes.rows,
    recent_logs: recentLogsRes.rows,
  });
});

// ============================================================================
// Endpoints de estado del pipeline e inspección de configuración efectiva
// ============================================================================

/**
 * GET /api/llm/status
 * Permite a cualquier pantalla del sistema consultar si el módulo LLM está listo
 * o si debe desactivar/ocultar las funciones de IA con un aviso manteniendo el pipeline local (Surya + reglas).
 */
llmPublicRouter.get('/status', async (_req, res: Response) => {
  const snap = await llmConfigCache.getSnapshot();
  const budget = await getBudgetStatus();
  const s = snap.settings;

  const hasValidKey = Boolean(s.api_key_encrypted);
  const ready = s.activo && hasValidKey && !budget.bloqueadoPorPresupuesto;

  let warningMessage: string | null = null;
  if (!s.activo) {
    warningMessage =
      'El módulo de Inteligencia Artificial (Claude) está deshabilitado por el administrador. Las funciones de IA están desactivadas; el pipeline local (Surya OCR + reglas) continúa activo.';
  } else if (!hasValidKey) {
    warningMessage =
      'No hay una clave de API válida configurada para Claude. Las funciones de IA están ocultas/desactivadas; el pipeline local (Surya OCR + reglas) continúa activo.';
  } else if (budget.bloqueadoPorPresupuesto) {
    warningMessage = `Límite de presupuesto alcanzado (${budget.avisos.join(' ')}). Llamadas a Claude en pausa; el pipeline local (Surya OCR + reglas) continúa activo.`;
  }

  res.json({
    ok: true,
    llm_enabled: s.activo,
    has_api_key: hasValidKey,
    ready,
    default_model: s.default_model,
    max_tokens: s.max_tokens,
    settings_version: s.version,
    local_pipeline: {
      surya_ocr: 'online',
      rules_engine: 'online',
      status: 'active',
    },
    budget,
    warning_message: warningMessage,
  });
});

/**
 * GET /api/llm/effective-config/:tarea
 * Verifica en tiempo real qué modelo y max_tokens usará la siguiente llamada sin reiniciar servicios.
 */
llmPublicRouter.get('/effective-config/:tarea', async (req, res: Response) => {
  const parsedTask = TaskNameSchema.safeParse(req.params.tarea);
  if (!parsedTask.success) {
    res.status(400).json({ ok: false, message: 'Tarea inválida' });
    return;
  }
  const effective = await llmConfigCache.getEffectiveTaskConfig(parsedTask.data);
  const { apiKeyEncrypted, ...safeEffective } = effective;
  res.json({
    ok: true,
    effective: safeEffective,
  });
});

/**
 * POST /api/llm/execute-task
 * Endpoint para ejecutar una tarea del pipeline (con soporte de extracción estructurada Zod o texto
 * y fallback automático al pipeline local Surya + reglas cuando el LLM está deshabilitado o sin clave).
 */
llmPublicRouter.post('/execute-task', async (req, res: Response) => {
  const schema = TaskNameSchema.safeParse(req.body?.tarea || 'completar_campos');
  if (!schema.success) {
    res.status(400).json({ ok: false, message: 'Tarea inválida' });
    return;
  }

  const tarea = schema.data;
  const textoDocumento = String(
    req.body?.texto ||
      'Licitación Pública Nacional LA-009000999-E45-2026 convocada por la Secretaría de Infraestructura para el Suministro de Servidores de Cómputo. Presupuesto estimado: $4,850,000 MXN. Fecha límite de entrega de propuestas: 2026-11-15. Requisitos: Certificación ISO 9001, Carta de fabricante, Garantía en sitio de 36 meses.'
  );

  try {
    if (tarea === 'completar_campos') {
      const result = await claudeService.extractStructuredJson({
        tarea,
        userPrompt: textoDocumento,
        toolName: 'extraer_campos_licitacion',
        toolDescription: 'Extrae campos estructurados de una convocatoria de licitación.',
        zodSchema: TenderExtractionSchema,
        tenderId: req.body?.tender_id || 'TND-2026-045',
        documentId: req.body?.document_id || 'DOC-PLIEGO-01',
      });

      if (result.fallbackLocalUsed) {
        res.json({
          ok: true,
          mode: 'local_pipeline_surya_rules',
          fallback_reason: result.fallbackReason,
          effective_model_configured: result.model,
          settings_version: result.settingsVersionUsed,
          local_extraction: {
            motor: 'Surya OCR + Reglas Regex Deterministas',
            tender_id: req.body?.tender_id || 'TND-2026-045',
            moneda_detectada: 'MXN',
            estado: 'Procesado localmente sin interrupción',
          },
        });
        return;
      }

      res.json({
        ok: true,
        mode: 'claude_structured_tool_use',
        result,
      });
      return;
    }

    const textResult = await claudeService.generateTaskText({
      tarea,
      userPrompt: textoDocumento,
      tenderId: req.body?.tender_id || 'TND-2026-045',
      documentId: req.body?.document_id || 'DOC-PLIEGO-01',
    });

    if (textResult.fallbackLocalUsed) {
      res.json({
        ok: true,
        mode: 'local_pipeline_surya_rules',
        fallback_reason: textResult.fallbackReason,
        effective_model_configured: textResult.model,
        settings_version: textResult.settingsVersionUsed,
        local_extraction: {
          motor: 'Surya OCR + Reglas Regex Deterministas',
          estado: 'Procesado localmente sin interrupción',
        },
      });
      return;
    }

    res.json({
      ok: true,
      mode: 'claude_messages_api',
      result: textResult,
    });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      message: err?.message || 'Error al ejecutar tarea LLM.',
    });
  }
});
