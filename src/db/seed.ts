import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './pool.js';
import { env } from '../config/env.js';
import { encryptApiKey } from '../modules/llm/crypto.service.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * Inicializa la base de datos con valores semilla desde variables de entorno
 * ÚNICAMENTE la primera vez (cuando llm_settings está vacía).
 * Después de esto, la base de datos manda y las variables de entorno no sobrescriben nada.
 */
export async function seedInitialLlmConfig(): Promise<void> {
  // 1. Verificar si ya existe algún modelo en llm_models; si está vacía, insertar catálogo base sincronizable
  const modelsCount = await db.query<{ count: string }>('SELECT COUNT(*)::text as count FROM llm_models');
  if (Number(modelsCount.rows[0]?.count || 0) === 0) {
    const initialModels = [
      {
        model_id: 'claude-sonnet-4-20250514',
        nombre_visible: 'Claude Sonnet 4 (Equilibrado / Producción)',
        max_output_tokens: 64000,
        ventana_contexto: 200000,
        precio_entrada_mtok: 3.0,
        precio_salida_mtok: 15.0,
        disponible: true,
      },
      {
        model_id: 'claude-3-7-sonnet-20250219',
        nombre_visible: 'Claude 3.7 Sonnet (Razonamiento Extendido)',
        max_output_tokens: 64000,
        ventana_contexto: 200000,
        precio_entrada_mtok: 3.0,
        precio_salida_mtok: 15.0,
        disponible: true,
      },
      {
        model_id: 'claude-3-5-sonnet-20241022',
        nombre_visible: 'Claude 3.5 Sonnet (v2)',
        max_output_tokens: 8192,
        ventana_contexto: 200000,
        precio_entrada_mtok: 3.0,
        precio_salida_mtok: 15.0,
        disponible: true,
      },
      {
        model_id: 'claude-3-5-haiku-20241022',
        nombre_visible: 'Claude 3.5 Haiku (Rápido / Económico)',
        max_output_tokens: 8192,
        ventana_contexto: 200000,
        precio_entrada_mtok: 0.8,
        precio_salida_mtok: 4.0,
        disponible: true,
      },
      {
        model_id: 'claude-opus-4-20250514',
        nombre_visible: 'Claude Opus 4 (Máxima Capacidad Analítica)',
        max_output_tokens: 32000,
        ventana_contexto: 200000,
        precio_entrada_mtok: 15.0,
        precio_salida_mtok: 75.0,
        disponible: true,
      },
    ];

    for (const m of initialModels) {
      await db.query(
        `INSERT INTO llm_models
          (model_id, nombre_visible, max_output_tokens, ventana_contexto, precio_entrada_mtok, precio_salida_mtok, disponible)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (model_id) DO NOTHING`,
        [
          m.model_id,
          m.nombre_visible,
          m.max_output_tokens,
          m.ventana_contexto,
          m.precio_entrada_mtok,
          m.precio_salida_mtok,
          m.disponible,
        ]
      );
    }
    console.log('[Seed] Catálogo inicial de llm_models creado (actualizable vía GET /v1/models).');
  }

  // 2. Verificar si llm_settings ya tiene registro. Si ya existe, NO sobrescribir (manda la BD).
  const settingsCheck = await db.query<{ count: string }>('SELECT COUNT(*)::text as count FROM llm_settings');
  if (Number(settingsCheck.rows[0]?.count || 0) === 0) {
    let encryptedKey: string | null = null;
    let last4: string | null = null;

    if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0) {
      const enc = encryptApiKey(env.ANTHROPIC_API_KEY);
      encryptedKey = enc.encrypted;
      last4 = enc.last4;
    }

    // Verificar que default_model exista en llm_models o tomar el primero disponible
    const modelExists = await db.query<{ model_id: string }>(
      'SELECT model_id FROM llm_models WHERE model_id = $1 LIMIT 1',
      [env.LLM_DEFAULT_MODEL]
    );
    let defaultModel = env.LLM_DEFAULT_MODEL;
    if (modelExists.rowCount === 0) {
      const firstModel = await db.query<{ model_id: string }>(
        'SELECT model_id FROM llm_models WHERE disponible = true ORDER BY precio_entrada_mtok ASC LIMIT 1'
      );
      defaultModel = firstModel.rows[0]?.model_id || env.LLM_DEFAULT_MODEL;
    }

    await db.query(
      `INSERT INTO llm_settings (
        id, provider, activo, version, api_key_encrypted, api_key_last4,
        api_base_url, anthropic_version, default_model, max_tokens,
        temperature, top_p, timeout_ms, max_retries, max_input_chars,
        limite_tokens_diario, limite_costo_mensual, accion_limite,
        created_by, updated_by
      ) VALUES (
        1, 'anthropic', $1, 1, $2, $3,
        $4, $5, $6, $7,
        $8, NULL, $9, $10, $11,
        500000, 100.00, 'avisar',
        'env_seed', 'env_seed'
      ) ON CONFLICT (id) DO NOTHING`,
      [
        Boolean(env.LLM_ENABLED),
        encryptedKey,
        last4,
        env.ANTHROPIC_BASE_URL,
        env.ANTHROPIC_VERSION,
        defaultModel,
        env.LLM_MAX_TOKENS,
        env.LLM_TEMPERATURE ?? 0.2,
        env.LLM_TIMEOUT_MS,
        env.LLM_MAX_RETRIES,
        env.LLM_MAX_INPUT_CHARS,
      ]
    );

    await db.query(
      `INSERT INTO llm_settings_history (entidad, accion, usuario, version_resultante, campos_modificados)
       VALUES ('llm_settings', 'seed', 'env_seed', 1, $1::jsonb)`,
      [
        JSON.stringify({
          nota: 'Configuración inicial sembrada desde variables de entorno (.env)',
          activo: Boolean(env.LLM_ENABLED),
          default_model: defaultModel,
          max_tokens: env.LLM_MAX_TOKENS,
          api_key: last4 ? `[CIFRADA sk-ant-…${last4}]` : '[SIN CLAVE]',
        }),
      ]
    );

    console.log('[Seed] Configuración inicial llm_settings creada desde variables de entorno.');
  }

  // 3. Sembrar los 4 perfiles de tarea en llm_task_profiles si no existen
  const profiles = [
    {
      tarea: 'completar_campos',
      nombre_tarea: 'Completar Campos de Licitación',
      descripcion: 'Extracción rápida en JSON estructurado de campos faltantes luego de Surya + reglas.',
      model: null, // Hereda default_model si va vacío
      max_tokens: 2048,
      temperature: 0.1,
      system_prompt:
        'Eres un asistente experto en contratación pública y licitaciones. Extrae con precisión los campos solicitados únicamente a partir del documento proporcionado. No inventes datos que no estén explícitos en el texto.',
      activo: true,
    },
    {
      tarea: 'resumen_licitacion',
      nombre_tarea: 'Resumen Ejecutivo de Licitación',
      descripcion: 'Genera síntesis ejecutiva con objeto, presupuesto, fechas clave y requisitos obligatorios.',
      model: null,
      max_tokens: 4096,
      temperature: 0.2,
      system_prompt:
        'Eres un analista senior de licitaciones. Elabora un resumen ejecutivo claro, estructurado y accionable destacando objeto del contrato, presupuesto base, plazos críticos, garantías y solvencia técnica/económica.',
      activo: true,
    },
    {
      tarea: 'analisis',
      nombre_tarea: 'Análisis de Pliegos y Riesgos',
      descripcion: 'Evaluación profunda de cláusulas críticas, penalizaciones, criterios de adjudicación y riesgos.',
      model: null,
      max_tokens: 8192,
      temperature: 0.2,
      system_prompt:
        'Eres un consultor jurídico y técnico especializado en pliegos de licitación. Analiza exhaustivamente riesgos contractuales, criterios de ponderación, causas de exclusión y viabilidad técnica.',
      activo: true,
    },
    {
      tarea: 'constructor_recetas',
      nombre_tarea: 'Constructor de Recetas de Extracción',
      descripcion: 'Generación asistida de selectores, expresiones regulares y reglas de scraping por portal.',
      model: null,
      max_tokens: 4096,
      temperature: 0.1,
      system_prompt:
        'Eres un ingeniero experto en web scraping, análisis DOM y expresiones regulares. Diseña recetas deterministas y robustas para extraer metadatos y documentos de portales de compras públicas.',
      activo: true,
    },
  ];

  for (const p of profiles) {
    await db.query(
      `INSERT INTO llm_task_profiles
        (tarea, nombre_tarea, descripcion, model, max_tokens, temperature, system_prompt, activo, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'env_seed')
       ON CONFLICT (tarea) DO NOTHING`,
      [
        p.tarea,
        p.nombre_tarea,
        p.descripcion,
        p.model,
        p.max_tokens,
        p.temperature,
        p.system_prompt,
        p.activo,
      ]
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  seedInitialLlmConfig()
    .then(() => {
      console.log('[Seed] Proceso de seed finalizado.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Seed] Error en seed:', err);
      process.exit(1);
    });
}
