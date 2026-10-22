import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { db } from '../../db/pool.js';
import { decryptApiKey } from './crypto.service.js';
import { llmConfigCache, LlmModelRecord } from './config.cache.js';
import { assertBudgetAllowsExecution } from './budget.service.js';
import { TaskName, TestLlmConnectionInput } from './llm.schemas.js';

export interface LlmCallOptions {
  tarea: TaskName;
  userPrompt: string;
  tenderId?: string;
  documentId?: string;
}

export interface LlmCallResult<T = string> {
  ok: boolean;
  data?: T;
  model: string;
  latencyMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    estimatedCostUsd: number;
  };
  settingsVersionUsed: number;
  fallbackLocalUsed?: boolean;
  fallbackReason?: string;
}

/**
 * Traduce cualquier error del SDK de Anthropic o de red a un mensaje claro en español para el administrador.
 * Asegura que jamás aparezca una API key en el mensaje.
 */
export function translateAnthropicError(err: any): {
  code: string;
  userMessage: string;
  httpStatus: number;
} {
  const rawMsg = String(err?.message || err || 'Error desconocido').replace(
    /sk-ant-[a-zA-Z0-9\-_]+/g,
    'sk-ant-…[REDACTED]'
  );
  const status = Number(err?.status || err?.statusCode || 0);

  if (status === 401 || /authentication_error|invalid x-api-key|api key/i.test(rawMsg)) {
    return {
      code: 'AUTHENTICATION_ERROR',
      httpStatus: 401,
      userMessage:
        'Clave de API inválida o revocada (401 Unauthorized). Verifica que la clave de Anthropic sea correcta y esté activa.',
    };
  }
  if (status === 403 || /permission_error/i.test(rawMsg)) {
    return {
      code: 'PERMISSION_ERROR',
      httpStatus: 403,
      userMessage:
        'Permiso denegado en Anthropic (403 Forbidden). Tu clave no tiene acceso al modelo o recurso solicitado.',
    };
  }
  if (status === 404 || /not_found_error|model:/i.test(rawMsg)) {
    return {
      code: 'MODEL_NOT_FOUND',
      httpStatus: 404,
      userMessage:
        'El modelo seleccionado no fue encontrado en la API de Anthropic (404). Usa "Sincronizar modelos" para actualizar el catálogo.',
    };
  }
  if (status === 429 || /rate_limit_error|credit balance is too low/i.test(rawMsg)) {
    if (/credit balance/i.test(rawMsg)) {
      return {
        code: 'INSUFFICIENT_CREDITS',
        httpStatus: 429,
        userMessage:
          'Saldo de créditos insuficiente en la cuenta de Anthropic. Recarga saldo en console.anthropic.com.',
      };
    }
    return {
      code: 'RATE_LIMIT_EXCEEDED',
      httpStatus: 429,
      userMessage:
        'Límite de velocidad alcanzado en Anthropic (429 Rate Limit). Se agotaron los reintentos con backoff.',
    };
  }
  if (status === 529 || /overloaded_error/i.test(rawMsg)) {
    return {
      code: 'ANTHROPIC_OVERLOADED',
      httpStatus: 529,
      userMessage:
        'Los servidores de Anthropic están temporalmente saturados (529 Overloaded). Intenta nuevamente en unos segundos.',
    };
  }
  if (status >= 500) {
    return {
      code: `ANTHROPIC_SERVER_${status}`,
      httpStatus: status,
      userMessage: `Error interno en los servidores de Anthropic (${status}).`,
    };
  }
  if (/timeout|timed out|AbortError|ETIMEDOUT/i.test(rawMsg)) {
    return {
      code: 'TIMEOUT_ERROR',
      httpStatus: 408,
      userMessage:
        'Tiempo de espera agotado (Timeout) al conectar con la API de Anthropic. Revisa el parámetro timeout_ms o tu conexión de red.',
    };
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(rawMsg)) {
    return {
      code: 'NETWORK_ERROR',
      httpStatus: 503,
      userMessage:
        'No se pudo establecer conexión de red con la URL base configurada. Verifica el campo api_base_url y tu salida a internet.',
    };
  }

  return {
    code: 'LLM_API_ERROR',
    httpStatus: status || 400,
    userMessage: `Error devuelto por la API: ${rawMsg}`,
  };
}

/**
 * Calcula el costo estimado en USD según los precios configurados en llm_models.
 * Contempla el descuento de Prompt Caching de Anthropic (lectura de caché = 10% del precio base, escritura = 125%).
 */
export function calculateEstimatedCostUsd(
  modelInfo: LlmModelRecord | null,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0
): number {
  const inputPricePerM = modelInfo ? modelInfo.precio_entrada_mtok : 3.0;
  const outputPricePerM = modelInfo ? modelInfo.precio_salida_mtok : 15.0;

  const costInput = (inputTokens / 1_000_000) * inputPricePerM;
  const costOutput = (outputTokens / 1_000_000) * outputPricePerM;
  const costCacheWrite = (cacheCreationTokens / 1_000_000) * (inputPricePerM * 1.25);
  const costCacheRead = (cacheReadTokens / 1_000_000) * (inputPricePerM * 0.1);

  return Number((costInput + costOutput + costCacheWrite + costCacheRead).toFixed(6));
}

/**
 * Registra cada llamada en la bitácora llm_usage.
 */
async function recordUsageLog(params: {
  tarea: string;
  modelo: string;
  tokensEntrada: number;
  tokensSalida: number;
  tokensCacheCreacion: number;
  tokensCacheLectura: number;
  costoEstimado: number;
  latenciaMs: number;
  exito: boolean;
  codigoError?: string | null;
  mensajeError?: string | null;
  tenderId?: string | null;
  documentId?: string | null;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO llm_usage (
        tarea, modelo, tokens_entrada, tokens_salida,
        tokens_cache_creacion, tokens_cache_lectura,
        costo_estimado, latencia_ms, exito,
        codigo_error, mensaje_error, tender_id, document_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        params.tarea,
        params.modelo,
        params.tokensEntrada,
        params.tokensSalida,
        params.tokensCacheCreacion,
        params.tokensCacheLectura,
        params.costoEstimado,
        params.latenciaMs,
        params.exito,
        params.codigoError || null,
        params.mensajeError || null,
        params.tenderId || null,
        params.documentId || null,
      ]
    );
  } catch (err: any) {
    console.error('[LLM Usage] Error al registrar bitácora llm_usage:', err.message);
  }
}

/**
 * Calcula la espera en ms ante errores 429 o 5xx respetando los encabezados de rate limit de Anthropic.
 */
function computeBackoffDelayMs(err: any, attempt: number): number {
  const headers = err?.headers || {};
  const retryAfterHeader =
    headers['retry-after'] ||
    (typeof headers.get === 'function' ? headers.get('retry-after') : undefined);

  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 60000);
    }
  }

  const resetHeader =
    headers['anthropic-ratelimit-tokens-reset'] ||
    headers['anthropic-ratelimit-requests-reset'] ||
    (typeof headers.get === 'function'
      ? headers.get('anthropic-ratelimit-tokens-reset') ||
        headers.get('anthropic-ratelimit-requests-reset')
      : undefined);

  if (resetHeader) {
    const resetTime = Date.parse(String(resetHeader));
    if (!Number.isNaN(resetTime)) {
      const waitMs = resetTime - Date.now();
      if (waitMs > 0 && waitMs < 60000) {
        return waitMs + 250;
      }
    }
  }

  // Backoff exponencial con jitter: 1s, 2s, 4s, 8s...
  const baseMs = Math.min(1000 * Math.pow(2, attempt), 30000);
  const jitter = Math.floor(Math.random() * 400);
  return baseMs + jitter;
}

/**
 * Ejecuta una llamada al SDK de Anthropic con reintentos y backoff ante errores 429 / 5xx,
 * respetando encabezados de rate limit.
 */
async function callWithRateLimitBackoff<R>(
  fn: () => Promise<R>,
  maxRetries: number
): Promise<R> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const status = Number(err?.status || err?.statusCode || 0);
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }
      const delayMs = computeBackoffDelayMs(err, attempt);
      attempt += 1;
      console.warn(
        `[Claude SDK] HTTP ${status} recibido. Reintento ${attempt}/${maxRetries} esperando ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Recorta el texto de entrada según max_input_chars configurado en llm_settings.
 */
export function truncateInputText(text: string, maxInputChars: number): string {
  if (!text || text.length <= maxInputChars) return text;
  return (
    text.slice(0, maxInputChars) +
    `\n\n[...TEXTO RECORTADO AUTOMÁTICAMENTE A ${maxInputChars} CARACTERES POR LÍMITE DE CONFIGURACIÓN...]`
  );
}

/**
 * Servicio principal de integración con Claude (@anthropic-ai/sdk).
 */
export class ClaudeService {
  /**
   * Botón "Probar conexión": hace una llamada mínima con la configuración del formulario
   * (aunque aún no esté guardada) y devuelve modelo, latencia, tokens usados o el error traducido.
   */
  async testConnection(input: TestLlmConnectionInput) {
    const snap = await llmConfigCache.getSnapshot();
    const s = snap.settings;

    // Usar la clave enviada en el formulario o, si no se envió una nueva, la ya guardada en BD
    let apiKeyToUse: string | null = null;
    if (input.api_key && input.api_key.trim().length > 0 && !input.api_key.includes('…')) {
      apiKeyToUse = input.api_key.trim();
    } else if (s.api_key_encrypted) {
      apiKeyToUse = decryptApiKey(s.api_key_encrypted);
    }

    if (!apiKeyToUse) {
      return {
        ok: false,
        model: input.model,
        latency_ms: 0,
        error_code: 'MISSING_API_KEY',
        error_message:
          'No hay ninguna clave de API configurada ni escrita en el formulario. Ingresa una clave válida (sk-ant-...) para probar la conexión.',
      };
    }

    const baseUrl = input.api_base_url || s.api_base_url || 'https://api.anthropic.com';
    const timeoutMs = input.timeout_ms || s.timeout_ms || 15000;
    const modelToTest = input.model || s.default_model;
    const startTime = Date.now();

    try {
      const client = new Anthropic({
        apiKey: apiKeyToUse,
        baseURL: baseUrl,
        timeout: timeoutMs,
        maxRetries: 0, // En test interactivo respondemos rápido
        defaultHeaders: {
          'anthropic-version': input.anthropic_version || s.anthropic_version || '2023-06-01',
        },
      });

      const response = await client.messages.create({
        model: modelToTest,
        max_tokens: Math.min(input.max_tokens || 32, 64),
        ...(input.temperature !== null && input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        messages: [
          {
            role: 'user',
            content: 'Responde únicamente con la palabra: CONEXION_OK',
          },
        ],
      });

      const latencyMs = Date.now() - startTime;
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cacheCreation = (response.usage as any)?.cache_creation_input_tokens || 0;
      const cacheRead = (response.usage as any)?.cache_read_input_tokens || 0;
      const modelInfo = snap.modelsMap[modelToTest] || null;
      const costUsd = calculateEstimatedCostUsd(
        modelInfo,
        inputTokens,
        outputTokens,
        cacheCreation,
        cacheRead
      );

      await recordUsageLog({
        tarea: 'test_conexion',
        modelo: response.model || modelToTest,
        tokensEntrada: inputTokens,
        tokensSalida: outputTokens,
        tokensCacheCreacion: cacheCreation,
        tokensCacheLectura: cacheRead,
        costoEstimado: costUsd,
        latenciaMs: latencyMs,
        exito: true,
      });

      const replyText =
        response.content?.[0]?.type === 'text' ? response.content[0].text.trim() : 'CONEXION_OK';

      return {
        ok: true,
        model: response.model || modelToTest,
        latency_ms: latencyMs,
        reply: replyText,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          estimated_cost_usd: costUsd,
        },
        message: `Conexión exitosa con Anthropic (${response.model || modelToTest}) en ${latencyMs} ms.`,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const translated = translateAnthropicError(err);

      await recordUsageLog({
        tarea: 'test_conexion',
        modelo: modelToTest,
        tokensEntrada: 0,
        tokensSalida: 0,
        tokensCacheCreacion: 0,
        tokensCacheLectura: 0,
        costoEstimado: 0,
        latenciaMs: latencyMs,
        exito: false,
        codigoError: translated.code,
        mensajeError: translated.userMessage,
      });

      return {
        ok: false,
        model: modelToTest,
        latency_ms: latencyMs,
        error_code: translated.code,
        error_message: translated.userMessage,
      };
    }
  }

  /**
   * Genera una respuesta de texto usando la configuración efectiva de la tarea desde la caché en memoria
   * (con Prompt Caching en el bloque system y recorte de max_input_chars).
   */
  async generateTaskText(options: LlmCallOptions): Promise<LlmCallResult<string>> {
    const cfg = await llmConfigCache.getEffectiveTaskConfig(options.tarea);

    // Regla: Si no hay clave válida o el LLM está deshabilitado, el pipeline local (Surya + reglas) sigue funcionando
    if (!cfg.globalActivo || !cfg.tareaActiva || !cfg.hasValidKey) {
      const reason = !cfg.globalActivo
        ? 'El módulo LLM general está deshabilitado.'
        : !cfg.tareaActiva
          ? `El perfil de la tarea "${options.tarea}" está deshabilitado.`
          : 'No hay una clave de API válida configurada.';

      return {
        ok: false,
        model: cfg.model,
        latencyMs: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          estimatedCostUsd: 0,
        },
        settingsVersionUsed: cfg.settingsVersion,
        fallbackLocalUsed: true,
        fallbackReason: `${reason} Ejecutando pipeline local (Surya OCR + motor de reglas).`,
      };
    }

    await assertBudgetAllowsExecution();

    const apiKey = decryptApiKey(cfg.apiKeyEncrypted);
    if (!apiKey) {
      throw new Error('No se pudo descifrar la clave de API.');
    }

    const truncatedInput = truncateInputText(options.userPrompt, cfg.maxInputChars);
    const startTime = Date.now();

    const client = new Anthropic({
      apiKey,
      baseURL: cfg.apiBaseUrl,
      timeout: cfg.timeoutMs,
      maxRetries: 0, // Manejado por callWithRateLimitBackoff para control fino de headers
      defaultHeaders: {
        'anthropic-version': cfg.anthropicVersion,
      },
    });

    try {
      const response = await callWithRateLimitBackoff(
        () =>
          client.messages.create({
            model: cfg.model,
            max_tokens: cfg.maxTokens,
            ...(cfg.temperature !== null ? { temperature: cfg.temperature } : {}),
            ...(cfg.topP !== null ? { top_p: cfg.topP } : {}),
            // Prompt Caching para las instrucciones de sistema que se repiten entre llamadas
            system: cfg.systemPrompt
              ? [
                  {
                    type: 'text',
                    text: cfg.systemPrompt,
                    cache_control: { type: 'ephemeral' },
                  },
                ]
              : undefined,
            messages: [
              {
                role: 'user',
                content: truncatedInput,
              },
            ],
          }),
        cfg.maxRetries
      );

      const latencyMs = Date.now() - startTime;
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cacheCreation = (response.usage as any)?.cache_creation_input_tokens || 0;
      const cacheRead = (response.usage as any)?.cache_read_input_tokens || 0;

      const costUsd = calculateEstimatedCostUsd(
        cfg.modelInfo,
        inputTokens,
        outputTokens,
        cacheCreation,
        cacheRead
      );

      await recordUsageLog({
        tarea: options.tarea,
        modelo: response.model || cfg.model,
        tokensEntrada: inputTokens,
        tokensSalida: outputTokens,
        tokensCacheCreacion: cacheCreation,
        tokensCacheLectura: cacheRead,
        costoEstimado: costUsd,
        latenciaMs: latencyMs,
        exito: true,
        tenderId: options.tenderId,
        documentId: options.documentId,
      });

      const textOutput = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return {
        ok: true,
        data: textOutput,
        model: response.model || cfg.model,
        latencyMs,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheCreation,
          cacheReadInputTokens: cacheRead,
          estimatedCostUsd: costUsd,
        },
        settingsVersionUsed: cfg.settingsVersion,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const translated = translateAnthropicError(err);

      await recordUsageLog({
        tarea: options.tarea,
        modelo: cfg.model,
        tokensEntrada: 0,
        tokensSalida: 0,
        tokensCacheCreacion: 0,
        tokensCacheLectura: 0,
        costoEstimado: 0,
        latenciaMs: latencyMs,
        exito: false,
        codigoError: translated.code,
        mensajeError: translated.userMessage,
        tenderId: options.tenderId,
        documentId: options.documentId,
      });

      throw new Error(translated.userMessage);
    }
  }

  /**
   * Realiza OCR de alta precisión sobre páginas de un PDF escaneado (imágenes JPEG renderizadas o PDF base64)
   * usando las capacidades multimodales de visión de Claude.
   */
  async extractTextFromScannedImages(params: {
    renderedPages: Array<{ page: number; media_type: 'image/jpeg' | 'image/png'; data: string }>;
    pdfBufferFallback?: Buffer;
    fileName?: string;
    tenderId?: string;
  }): Promise<string | null> {
    const cfg = await llmConfigCache.getEffectiveTaskConfig('resumen_licitacion');
    if (!cfg.globalActivo || !cfg.hasValidKey) {
      return null;
    }

    await assertBudgetAllowsExecution();
    const apiKey = decryptApiKey(cfg.apiKeyEncrypted);
    if (!apiKey) return null;

    const startTime = Date.now();
    const client = new Anthropic({
      apiKey,
      baseURL: cfg.apiBaseUrl,
      timeout: Math.max(cfg.timeoutMs, 60000),
      maxRetries: 0,
      defaultHeaders: {
        'anthropic-version': cfg.anthropicVersion,
      },
    });

    const contentBlocks: any[] = [];

    if (params.renderedPages && params.renderedPages.length > 0) {
      for (const p of params.renderedPages.slice(0, 10)) {
        contentBlocks.push({
          type: 'text',
          text: `Página ${p.page}:`,
        });
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: p.media_type || 'image/jpeg',
            data: p.data,
          },
        });
      }
    } else if (params.pdfBufferFallback && params.pdfBufferFallback.length <= 20 * 1024 * 1024) {
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: params.pdfBufferFallback.toString('base64'),
        },
      });
    } else {
      return null;
    }

    contentBlocks.push({
      type: 'text',
      text:
        'Realiza el OCR completo y fiel de todas las páginas mostradas de este documento de licitación. ' +
        'Transcribe íntegramente todas las tablas (números de licitación, conceptos/descripciones, fechas, horarios, costos de bases, cantidades) y todo el texto legal. ' +
        'Separa cada página con el encabezado "--- PÁGINA N ---".',
    });

    try {
      const response = await callWithRateLimitBackoff(
        () =>
          client.messages.create({
            model: cfg.model,
            max_tokens: Math.max(cfg.maxTokens, 4096),
            temperature: 0,
            messages: [
              {
                role: 'user',
                content: contentBlocks,
              },
            ],
          }),
        cfg.maxRetries
      );

      const latencyMs = Date.now() - startTime;
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cacheCreation = (response.usage as any)?.cache_creation_input_tokens || 0;
      const cacheRead = (response.usage as any)?.cache_read_input_tokens || 0;
      const costUsd = calculateEstimatedCostUsd(
        cfg.modelInfo,
        inputTokens,
        outputTokens,
        cacheCreation,
        cacheRead
      );

      await recordUsageLog({
        tarea: 'ocr_imagen_pdf',
        modelo: response.model || cfg.model,
        tokensEntrada: inputTokens,
        tokensSalida: outputTokens,
        tokensCacheCreacion: cacheCreation,
        tokensCacheLectura: cacheRead,
        costoEstimado: costUsd,
        latenciaMs: latencyMs,
        exito: true,
        tenderId: params.tenderId,
        documentId: params.fileName || 'SCANNED-PDF',
      });

      const ocrText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      return ocrText.length > 0 ? ocrText : null;
    } catch (err: any) {
      console.warn('[Vision OCR] Aviso al procesar OCR de imagen:', err?.message);
      return null;
    }
  }

  /**
   * Extracción en JSON estructurado usando Tool Use con esquema definido,
   * Prompt Caching tanto en system como en el esquema de la herramienta,
   * y validación estricta de la respuesta con Zod.
   */
  async extractStructuredJson<T>(
    options: LlmCallOptions & {
      toolName: string;
      toolDescription: string;
      zodSchema: z.ZodType<T>;
    }
  ): Promise<LlmCallResult<T>> {
    const cfg = await llmConfigCache.getEffectiveTaskConfig(options.tarea);

    if (!cfg.globalActivo || !cfg.tareaActiva || !cfg.hasValidKey) {
      const reason = !cfg.globalActivo
        ? 'El módulo LLM general está deshabilitado.'
        : !cfg.tareaActiva
          ? `El perfil de la tarea "${options.tarea}" está deshabilitado.`
          : 'No hay una clave de API válida configurada.';

      return {
        ok: false,
        model: cfg.model,
        latencyMs: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          estimatedCostUsd: 0,
        },
        settingsVersionUsed: cfg.settingsVersion,
        fallbackLocalUsed: true,
        fallbackReason: `${reason} Ejecutando pipeline local (Surya OCR + motor de reglas).`,
      };
    }

    await assertBudgetAllowsExecution();

    const apiKey = decryptApiKey(cfg.apiKeyEncrypted);
    if (!apiKey) {
      throw new Error('No se pudo descifrar la clave de API.');
    }

    const rawJsonSchema = zodToJsonSchema(options.zodSchema, { target: 'jsonSchema7' }) as Record<
      string,
      any
    >;
    const inputSchema: Anthropic.Tool.InputSchema = {
      type: 'object',
      properties: rawJsonSchema.properties || {},
      required: rawJsonSchema.required || [],
    };

    const truncatedInput = truncateInputText(options.userPrompt, cfg.maxInputChars);
    const startTime = Date.now();

    const client = new Anthropic({
      apiKey,
      baseURL: cfg.apiBaseUrl,
      timeout: cfg.timeoutMs,
      maxRetries: 0,
      defaultHeaders: {
        'anthropic-version': cfg.anthropicVersion,
      },
    });

    try {
      let response: Anthropic.Message;
      try {
        response = await callWithRateLimitBackoff(
          () =>
            client.messages.create({
              model: cfg.model,
              max_tokens: cfg.maxTokens,
              ...(cfg.temperature !== null ? { temperature: cfg.temperature } : {}),
              system: cfg.systemPrompt
                ? [
                    {
                      type: 'text',
                      text: cfg.systemPrompt,
                      cache_control: { type: 'ephemeral' },
                    },
                  ]
                : undefined,
              tools: [
                {
                  name: options.toolName,
                  description: options.toolDescription,
                  input_schema: inputSchema,
                  cache_control: { type: 'ephemeral' },
                } as any,
              ],
              tool_choice: {
                type: 'auto',
              },
              messages: [
                {
                  role: 'user',
                  content:
                    `Utiliza la herramienta "${options.toolName}" (o devuelve exclusivamente un objeto JSON válido con ese esquema) para extraer los datos del siguiente documento:\n\n` +
                    truncatedInput,
                },
              ],
            }),
          cfg.maxRetries
        );
      } catch (toolErr: any) {
        // Si el modelo seleccionado no soporta tools o tool_choice, hacer fallback transparente a salida JSON por texto
        response = await callWithRateLimitBackoff(
          () =>
            client.messages.create({
              model: cfg.model,
              max_tokens: cfg.maxTokens,
              ...(cfg.temperature !== null ? { temperature: cfg.temperature } : {}),
              system: cfg.systemPrompt,
              messages: [
                {
                  role: 'user',
                  content:
                    `Responde ÚNICAMENTE con un objeto JSON válido (sin texto adicional ni bloques markdown) que cumpla con estas propiedades: ${JSON.stringify(
                      inputSchema.properties
                    )}\n\nTexto a analizar:\n` + truncatedInput,
                },
              ],
            }),
          cfg.maxRetries
        );
      }

      const latencyMs = Date.now() - startTime;
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cacheCreation = (response.usage as any)?.cache_creation_input_tokens || 0;
      const cacheRead = (response.usage as any)?.cache_read_input_tokens || 0;
      const costUsd = calculateEstimatedCostUsd(
        cfg.modelInfo,
        inputTokens,
        outputTokens,
        cacheCreation,
        cacheRead
      );

      const toolUseBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === options.toolName
      );

      let rawCandidate: any = toolUseBlock?.input;

      if (!rawCandidate) {
        const textContent = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          rawCandidate = JSON.parse(jsonMatch[0]);
        }
      }

      if (!rawCandidate) {
        throw new Error('El modelo no devolvió datos estructurados válidos.');
      }

      // Validar la salida estructurada con Zod
      const parsedData = options.zodSchema.parse(rawCandidate);

      await recordUsageLog({
        tarea: options.tarea,
        modelo: response.model || cfg.model,
        tokensEntrada: inputTokens,
        tokensSalida: outputTokens,
        tokensCacheCreacion: cacheCreation,
        tokensCacheLectura: cacheRead,
        costoEstimado: costUsd,
        latenciaMs: latencyMs,
        exito: true,
        tenderId: options.tenderId,
        documentId: options.documentId,
      });

      return {
        ok: true,
        data: parsedData,
        model: response.model || cfg.model,
        latencyMs,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheCreation,
          cacheReadInputTokens: cacheRead,
          estimatedCostUsd: costUsd,
        },
        settingsVersionUsed: cfg.settingsVersion,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const translated = translateAnthropicError(err);

      await recordUsageLog({
        tarea: options.tarea,
        modelo: cfg.model,
        tokensEntrada: 0,
        tokensSalida: 0,
        tokensCacheCreacion: 0,
        tokensCacheLectura: 0,
        costoEstimado: 0,
        latenciaMs: latencyMs,
        exito: false,
        codigoError: translated.code,
        mensajeError: translated.userMessage,
        tenderId: options.tenderId,
        documentId: options.documentId,
      });

      throw new Error(translated.userMessage);
    }
  }
}

export const claudeService = new ClaudeService();
