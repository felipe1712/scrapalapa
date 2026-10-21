import { db } from '../../db/pool.js';
import { decryptApiKey } from './crypto.service.js';
import { llmConfigCache } from './config.cache.js';
import { translateAnthropicError } from './claude.service.js';

interface AnthropicModelItem {
  id: string;
  display_name?: string;
  created_at?: string;
  type?: string;
}

/**
 * Infiere valores iniciales razonables de límites y precios para un modelo nuevo descubierto en GET /v1/models
 * basándose en su familia (sin hardcodear IDs fijos; el admin siempre puede editarlos en la tabla llm_models).
 */
function inferDefaultSpecsFromFamily(modelId: string) {
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) {
    return {
      maxOutputTokens: lower.includes('4') ? 32000 : 4096,
      contextWindow: 200000,
      inputPrice: 15.0,
      outputPrice: 75.0,
    };
  }
  if (lower.includes('haiku')) {
    return {
      maxOutputTokens: 8192,
      contextWindow: 200000,
      inputPrice: 0.8,
      outputPrice: 4.0,
    };
  }
  if (lower.includes('3-7') || lower.includes('sonnet-4') || lower.includes('4-')) {
    return {
      maxOutputTokens: 64000,
      contextWindow: 200000,
      inputPrice: 3.0,
      outputPrice: 15.0,
    };
  }
  return {
    maxOutputTokens: 8192,
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
  };
}

/**
 * Botón "Sincronizar modelos":
 * Consulta GET /v1/models de la API de Anthropic y actualiza la lista disponible en llm_models.
 */
export async function syncModelsFromAnthropicApi(
  overrideApiKey?: string | null,
  usuario = 'admin'
): Promise<{
  ok: boolean;
  syncedCount: number;
  models: any[];
  message: string;
}> {
  const snap = await llmConfigCache.getSnapshot();
  const s = snap.settings;

  let apiKey: string | null = null;
  if (overrideApiKey && overrideApiKey.trim().length > 0 && !overrideApiKey.includes('…')) {
    apiKey = overrideApiKey.trim();
  } else if (s.api_key_encrypted) {
    apiKey = decryptApiKey(s.api_key_encrypted);
  }

  if (!apiKey) {
    const current = await llmConfigCache.getSnapshot(true);
    return {
      ok: false,
      syncedCount: 0,
      models: current.models,
      message:
        'Para sincronizar desde GET /v1/models de Anthropic necesitas ingresar o guardar primero una clave de API válida.',
    };
  }

  const baseUrl = (s.api_base_url || 'https://api.anthropic.com').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/models?limit=100`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), s.timeout_ms || 20000);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': s.anthropic_version || '2023-06-01',
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const errObj: any = new Error(errBody || `HTTP ${res.status}`);
      errObj.status = res.status;
      const translated = translateAnthropicError(errObj);
      return {
        ok: false,
        syncedCount: 0,
        models: snap.models,
        message: translated.userMessage,
      };
    }

    const payload = (await res.json()) as { data?: AnthropicModelItem[] };
    const remoteModels = Array.isArray(payload?.data) ? payload.data : [];

    if (remoteModels.length === 0) {
      return {
        ok: true,
        syncedCount: 0,
        models: snap.models,
        message: 'La API de Anthropic respondió correctamente pero no devolvió modelos nuevos.',
      };
    }

    const remoteIds = new Set<string>();
    for (const item of remoteModels) {
      if (!item?.id) continue;
      remoteIds.add(item.id);
      const specs = inferDefaultSpecsFromFamily(item.id);
      const displayName = item.display_name || item.id;

      // Insertar nuevos modelos o actualizar nombre_visible y disponible=true sin pisar precios editados por el admin
      await db.query(
        `INSERT INTO llm_models (
          model_id, nombre_visible, max_output_tokens, ventana_contexto,
          precio_entrada_mtok, precio_salida_mtok, disponible, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
        ON CONFLICT (model_id) DO UPDATE SET
          nombre_visible = EXCLUDED.nombre_visible,
          disponible = true,
          updated_at = NOW()`,
        [
          item.id,
          displayName,
          specs.maxOutputTokens,
          specs.contextWindow,
          specs.inputPrice,
          specs.outputPrice,
        ]
      );
    }

    await db.query(
      `INSERT INTO llm_settings_history (entidad, accion, usuario, version_resultante, campos_modificados)
       VALUES ('llm_models', 'sync_models', $1, $2, $3::jsonb)`,
      [
        usuario,
        s.version,
        JSON.stringify({
          total_modelos_sincronizados: remoteIds.size,
          modelos: Array.from(remoteIds),
        }),
      ]
    );

    await llmConfigCache.invalidateAndNotify('models_synced', { count: remoteIds.size });
    const updatedSnap = await llmConfigCache.getSnapshot(true);

    return {
      ok: true,
      syncedCount: remoteIds.size,
      models: updatedSnap.models,
      message: `Se sincronizaron ${remoteIds.size} modelos desde GET /v1/models de Anthropic.`,
    };
  } catch (err: any) {
    const translated = translateAnthropicError(err);
    return {
      ok: false,
      syncedCount: 0,
      models: snap.models,
      message: translated.userMessage,
    };
  }
}
