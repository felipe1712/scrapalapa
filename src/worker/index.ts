import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/pool.js';
import { llmConfigCache } from '../modules/llm/config.cache.js';
import { claudeService } from '../modules/llm/claude.service.js';
import { TenderExtractionSchema } from '../modules/llm/llm.schemas.js';

const __filename = fileURLToPath(import.meta.url);

export class ScrapperLlmWorker {
  private lastKnownVersion = 0;

  async start(): Promise<void> {
    await db.init();
    await llmConfigCache.initListener();

    const snap = await llmConfigCache.getSnapshot();
    this.lastKnownVersion = snap.settings.version;

    console.log(
      `[Worker] Iniciado con configuración LLM v${snap.settings.version} | Modelo default: ${snap.settings.default_model} | max_tokens: ${snap.settings.max_tokens} | Activo: ${snap.settings.activo}`
    );

    // Suscribirse a notificaciones de PostgreSQL (LISTEN llm_config_changed)
    await db.listen('llm_config_changed', async (payload) => {
      const updated = await llmConfigCache.getSnapshot(true);
      this.lastKnownVersion = updated.settings.version;
      console.log(
        `[Worker Hot-Reload] Configuración actualizada en vivo (v${updated.settings.version}) sin reiniciar -> Modelo: ${updated.settings.default_model}, max_tokens: ${updated.settings.max_tokens}, Activo: ${updated.settings.activo} | Evento: ${payload}`
      );
    });
  }

  /**
   * Procesa un documento de licitación en el worker usando la configuración actual en memoria
   * (o hace fallback inmediato a Surya OCR + reglas si el LLM está apagado o sin clave).
   */
  async processTenderDocument(tenderId: string, documentId: string, rawText: string) {
    const effective = await llmConfigCache.getEffectiveTaskConfig('completar_campos');
    console.log(
      `[Worker] Procesando licitación ${tenderId} con config v${effective.settingsVersion} (Modelo: ${effective.model}, max_tokens: ${effective.maxTokens})`
    );

    const res = await claudeService.extractStructuredJson({
      tarea: 'completar_campos',
      userPrompt: rawText,
      toolName: 'extraer_campos_licitacion',
      toolDescription: 'Extrae campos estructurados de una licitación pública validados con Zod',
      zodSchema: TenderExtractionSchema,
      tenderId,
      documentId,
    });

    return res;
  }
}

export const workerInstance = new ScrapperLlmWorker();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  workerInstance.start().catch((err) => {
    console.error('[Worker] Error fatal al iniciar:', err);
    process.exit(1);
  });
}
