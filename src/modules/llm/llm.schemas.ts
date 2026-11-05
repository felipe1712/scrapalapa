import { z } from 'zod';

export const TaskNameSchema = z.enum([
  'completar_campos',
  'resumen_licitacion',
  'analisis',
  'constructor_recetas',
]);

export type TaskName = z.infer<typeof TaskNameSchema>;

export const BudgetActionSchema = z.enum(['pausar', 'avisar']);
export type BudgetAction = z.infer<typeof BudgetActionSchema>;

/**
 * Esquema Zod para PUT /api/settings/llm
 */
export const UpdateLlmSettingsSchema = z.object({
  activo: z.boolean(),
  api_key: z.string().trim().min(10, 'La clave de API es demasiado corta').optional().nullable(),
  remove_api_key: z.boolean().optional().default(false),
  api_base_url: z
    .string()
    .trim()
    .url('La URL base debe ser una URL válida (ej. https://api.anthropic.com)')
    .default('https://api.anthropic.com'),
  anthropic_version: z.string().trim().min(4).default('2023-06-01'),
  default_model: z.string().trim().min(1, 'Debes seleccionar un modelo por defecto'),
  max_tokens: z.coerce
    .number()
    .int()
    .min(1, 'max_tokens debe ser al menos 1')
    .max(200000, 'max_tokens excede el límite permitido'),
  temperature: z
    .union([z.coerce.number().min(0).max(1), z.literal(''), z.null(), z.undefined()])
    .transform((v) => (v === '' || v === undefined || v === null ? null : Number(v))),
  top_p: z
    .union([z.coerce.number().min(0).max(1), z.literal(''), z.null(), z.undefined()])
    .transform((v) => (v === '' || v === undefined || v === null ? null : Number(v))),
  timeout_ms: z.coerce
    .number()
    .int()
    .min(1000, 'El timeout mínimo es 1000 ms')
    .max(600000, 'El timeout máximo es 600000 ms')
    .default(60000),
  max_retries: z.coerce.number().int().min(0).max(10).default(3),
  max_input_chars: z.coerce
    .number()
    .int()
    .min(500, 'El límite de caracteres de entrada debe ser al menos 500')
    .max(5000000)
    .default(120000),
  limite_tokens_diario: z
    .union([z.coerce.number().int().positive(), z.literal(''), z.null(), z.undefined()])
    .transform((v) => (v === '' || v === undefined || v === null ? null : Number(v))),
  limite_costo_mensual: z
    .union([z.coerce.number().positive(), z.literal(''), z.null(), z.undefined()])
    .transform((v) => (v === '' || v === undefined || v === null ? null : Number(v))),
  accion_limite: BudgetActionSchema.default('avisar'),
});

export type UpdateLlmSettingsInput = z.infer<typeof UpdateLlmSettingsSchema>;

/**
 * Esquema Zod para POST /api/settings/llm/test
 * Permite probar con la configuración del formulario aunque aún no esté guardada.
 */
export const TestLlmConnectionSchema = z.object({
  api_key: z.string().trim().optional().nullable(),
  api_base_url: z.string().trim().url().optional().default('https://api.anthropic.com'),
  anthropic_version: z.string().trim().optional().default('2023-06-01'),
  model: z.string().trim().min(1, 'Debes indicar un modelo para probar la conexión'),
  max_tokens: z.coerce.number().int().min(1).max(200000).optional().default(64),
  temperature: z
    .union([z.coerce.number().min(0).max(1), z.literal(''), z.null(), z.undefined()])
    .transform((v) => (v === '' || v === undefined || v === null ? null : Number(v))),
  timeout_ms: z.coerce.number().int().min(1000).max(120000).optional().default(15000),
  max_retries: z.coerce.number().int().min(0).max(5).optional().default(0),
});

export type TestLlmConnectionInput = z.infer<typeof TestLlmConnectionSchema>;

/**
 * Esquema Zod para PUT /api/settings/llm/profiles
 */
export const SingleTaskProfileSchema = z.object({
  tarea: TaskNameSchema,
  model: z
    .union([z.string().trim(), z.null(), z.undefined()])
    .transform((v) => (!v || v.trim() === '' ? null : v.trim())),
  max_tokens: z
    .union([z.coerce.number().int().positive(), z.literal(''), z.null(), z.undefined()])
    .transform((v) => (v === '' || v === undefined || v === null ? null : Number(v))),
  temperature: z
    .union([z.coerce.number().min(0).max(1), z.literal(''), z.null(), z.undefined()])
    .transform((v) => (v === '' || v === undefined || v === null ? null : Number(v))),
  system_prompt: z.string().default(''),
  activo: z.boolean().default(true),
});

export const UpdateTaskProfilesSchema = z.object({
  profiles: z.array(SingleTaskProfileSchema).min(1),
});

export type UpdateTaskProfilesInput = z.infer<typeof UpdateTaskProfilesSchema>;

/**
 * Esquema Zod para actualizar catálogo/precios de modelos (PUT /api/settings/llm/models/:modelId o en lote)
 */
export const UpdateModelPricingSchema = z.object({
  models: z
    .array(
      z.object({
        model_id: z.string().trim().min(1),
        nombre_visible: z.string().trim().min(1).optional(),
        max_output_tokens: z.coerce.number().int().positive().optional(),
        ventana_contexto: z.coerce.number().int().positive().optional(),
        precio_entrada_mtok: z.coerce.number().min(0),
        precio_salida_mtok: z.coerce.number().min(0),
        disponible: z.boolean(),
      })
    )
    .min(1),
});

/**
 * Esquema Zod para GET /api/settings/llm/usage
 */
export const UsageQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  tarea: z.string().optional(),
  modelo: z.string().optional(),
  format: z.enum(['json', 'csv']).optional().default('json'),
  limit: z.coerce.number().int().min(1).max(5000).optional().default(200),
});

export type UsageQueryInput = z.infer<typeof UsageQuerySchema>;

/**
 * Hito o evento del cronograma de una licitación (Junta de Aclaraciones, Apertura, Fallo, etc.)
 */
export const TenderMilestoneSchema = z.object({
  evento: z.string().describe('Nombre del acto o trámite (ej. Publicación de Convocatoria, Junta de Aclaraciones, Apertura de Proposiciones, Fallo, Firma de Contrato)'),
  fecha: z.string().optional().default('Por definir').describe('Fecha del evento en formato YYYY-MM-DD o DD/MM/YYYY'),
  hora: z.string().optional().default('').describe('Hora del evento (ej. 10:00 hrs)'),
  lugar: z.string().optional().default('').describe('Lugar o modalidad de celebración (ej. Sala de Licitaciones, Remoto por CompraNet)'),
  estado: z.enum(['completado', 'proximo', 'pendiente']).optional().default('proximo'),
});

export type TenderMilestone = z.infer<typeof TenderMilestoneSchema>;

/**
 * Esquema específico para extracción y actualización de cronogramas y fechas clave.
 */
export const TenderTimelineExtractionSchema = z.object({
  cronograma: z.array(TenderMilestoneSchema).optional().default([]).describe('Lista cronológica de los actos legales y fechas clave del procedimiento'),
  requisitos_clave: z.array(z.string()).optional().default([]).describe('Lista de requisitos indispensables técnicos, legales o financieros'),
  alcance_periodo: z.string().optional().default('').describe('Vigencia, alcance o periodo de contratación'),
});

export type TenderTimelineExtraction = z.infer<typeof TenderTimelineExtractionSchema>;

/**
 * Procedimiento / Licitación individual identificada dentro de la convocatoria o documento
 */
export const TenderProcedureSchema = z.object({
  numero_procedimiento: z.string().optional().default('').describe('Número o código oficial de la licitación (ej. PJCDMX/LPN-01/2026, LA-050GYR-E1-2026)'),
  titulo_objeto: z.string().optional().default('').describe('Objeto o descripción clara de los bienes, suministros o servicios licitados'),
  entidad_convocante: z.string().optional().default('').describe('Organismo o dependencia convocante'),
  alcance_periodo: z.string().optional().default('').describe('Periodo de vigencia del contrato, volumen estimado de partidas o periodicidad del servicio'),
  cronograma: z.array(TenderMilestoneSchema).optional().default([]).describe('Cronograma secuencial de fechas de los actos del procedimiento'),
  requisitos_clave: z.array(z.string()).optional().default([]).describe('Requisitos técnicos, legales o financieros indispensables'),
  resumen_ejecutivo: z.string().optional().default('').describe('Síntesis concisa de los aspectos más relevantes para el licitante'),
});

export type TenderProcedure = z.infer<typeof TenderProcedureSchema>;

/**
 * Esquema de extracción estructurada en JSON para documentos de licitación.
 * Soporta convocatorias con múltiples licitaciones desglosadas (drill-down).
 */
export const TenderExtractionSchema = z.object({
  titulo_convocatoria: z.string().optional().describe('Título de la publicación, gaceta o documento general'),
  titulo_licitacion: z.string().optional().describe('Título principal o primer procedimiento'),
  entidad_convocante: z.string().optional().default('').describe('Organismo, dependencia o institución que convoca'),
  procedimientos: z.array(TenderProcedureSchema).optional().default([]).describe('Lista de todos los procedimientos o licitaciones individuales contenidas en el documento'),
  cronograma_general: z.array(TenderMilestoneSchema).optional().default([]).describe('Fechas y actos aplicables a la convocatoria'),
  presupuesto_estimado: z.number().nullable().optional().describe('Monto numérico del presupuesto base o costo de bases si viene publicado'),
  moneda: z.string().default('MXN').describe('Código ISO de moneda (MXN, USD, etc.)'),
  fecha_limite_propuestas: z.string().nullable().optional().describe('Fecha límite principal de entrega'),
  requisitos_clave: z.array(z.string()).optional().default([]).describe('Lista de requisitos generales'),
  nivel_riesgo: z.enum(['bajo', 'medio', 'alto']).optional().default('medio'),
});

export type TenderExtraction = z.infer<typeof TenderExtractionSchema>;
