import { db } from '../../db/pool.js';
import { formatMaskedApiKey } from './crypto.service.js';
import { TaskName } from './llm.schemas.js';

export interface LlmModelRecord {
  model_id: string;
  nombre_visible: string;
  max_output_tokens: number;
  ventana_contexto: number;
  precio_entrada_mtok: number;
  precio_salida_mtok: number;
  disponible: boolean;
  personalizado_precios: boolean;
  updated_at: string;
}

export interface LlmSettingsRecord {
  id: number;
  provider: string;
  activo: boolean;
  version: number;
  api_key_encrypted: string | null;
  api_key_last4: string | null;
  api_base_url: string;
  anthropic_version: string;
  default_model: string;
  max_tokens: number;
  temperature: number | null;
  top_p: number | null;
  timeout_ms: number;
  max_retries: number;
  max_input_chars: number;
  limite_tokens_diario: number | null;
  limite_costo_mensual: number | null;
  accion_limite: 'pausar' | 'avisar';
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface LlmTaskProfileRecord {
  tarea: TaskName;
  nombre_tarea: string;
  descripcion: string | null;
  model: string | null;
  max_tokens: number | null;
  temperature: number | null;
  system_prompt: string;
  activo: boolean;
  updated_by: string;
  updated_at: string;
}

export interface EffectiveTaskConfig {
  tarea: TaskName;
  provider: string;
  globalActivo: boolean;
  tareaActiva: boolean;
  hasValidKey: boolean;
  apiKeyEncrypted: string | null;
  apiBaseUrl: string;
  anthropicVersion: string;
  model: string;
  modelInfo: LlmModelRecord | null;
  maxTokens: number;
  temperature: number | null;
  topP: number | null;
  timeoutMs: number;
  maxRetries: number;
  maxInputChars: number;
  systemPrompt: string;
  settingsVersion: number;
}

export interface CachedLlmSnapshot {
  settings: LlmSettingsRecord;
  profiles: Record<TaskName, LlmTaskProfileRecord>;
  models: LlmModelRecord[];
  modelsMap: Record<string, LlmModelRecord>;
  loadedAt: number;
  invalidationCount: number;
  lastNotificationPayload: string | null;
}

class LlmConfigCacheManager {
  private snapshot: CachedLlmSnapshot | null = null;
  private loadingPromise: Promise<CachedLlmSnapshot> | null = null;
  private listenerInitialized = false;
  private invalidationCount = 0;
  private lastNotificationPayload: string | null = null;

  /**
   * Inicializa la suscripción LISTEN 'llm_config_changed' en PostgreSQL
   * para invalidar la caché en memoria automáticamente cuando cambie la BD.
   */
  async initListener(): Promise<void> {
    if (this.listenerInitialized) return;
    this.listenerInitialized = true;

    await db.listen('llm_config_changed', (payload) => {
      this.invalidationCount += 1;
      this.lastNotificationPayload = payload;
      this.snapshot = null;
      console.log(
        `[LLM Cache] Invalidación #${this.invalidationCount} recibida por NOTIFY (llm_config_changed): ${payload}`
      );
    });
  }

  /**
   * Fuerza la invalidación local y emite pg_notify a todos los procesos (API + Worker).
   */
  async invalidateAndNotify(reason: string, details: Record<string, any> = {}): Promise<void> {
    this.snapshot = null;
    await db.notify('llm_config_changed', { reason, ...details });
  }

  /**
   * Obtiene el snapshot desde la caché en memoria o lo carga desde PostgreSQL si fue invalidado.
   */
  async getSnapshot(forceReload = false): Promise<CachedLlmSnapshot> {
    await this.initListener();

    if (!forceReload && this.snapshot) {
      return this.snapshot;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this._loadFromDatabase();
    try {
      this.snapshot = await this.loadingPromise;
      return this.snapshot;
    } finally {
      this.loadingPromise = null;
    }
  }

  private async _loadFromDatabase(): Promise<CachedLlmSnapshot> {
    const settingsRes = await db.query<any>('SELECT * FROM llm_settings ORDER BY id ASC LIMIT 1');
    const modelsRes = await db.query<any>(
      'SELECT * FROM llm_models ORDER BY disponible DESC, nombre_visible ASC'
    );
    const profilesRes = await db.query<any>('SELECT * FROM llm_task_profiles ORDER BY tarea ASC');

    const rawSettings = settingsRes.rows[0];
    if (!rawSettings) {
      throw new Error('La tabla llm_settings no contiene registros. Ejecuta el seeder inicial.');
    }

    const settings: LlmSettingsRecord = {
      id: Number(rawSettings.id),
      provider: rawSettings.provider,
      activo: Boolean(rawSettings.activo),
      version: Number(rawSettings.version),
      api_key_encrypted: rawSettings.api_key_encrypted || null,
      api_key_last4: rawSettings.api_key_last4 || null,
      api_base_url: rawSettings.api_base_url,
      anthropic_version: rawSettings.anthropic_version,
      default_model: rawSettings.default_model,
      max_tokens: Number(rawSettings.max_tokens),
      temperature: rawSettings.temperature !== null ? Number(rawSettings.temperature) : null,
      top_p: rawSettings.top_p !== null ? Number(rawSettings.top_p) : null,
      timeout_ms: Number(rawSettings.timeout_ms),
      max_retries: Number(rawSettings.max_retries),
      max_input_chars: Number(rawSettings.max_input_chars),
      limite_tokens_diario:
        rawSettings.limite_tokens_diario !== null ? Number(rawSettings.limite_tokens_diario) : null,
      limite_costo_mensual:
        rawSettings.limite_costo_mensual !== null ? Number(rawSettings.limite_costo_mensual) : null,
      accion_limite: rawSettings.accion_limite,
      created_by: rawSettings.created_by,
      updated_by: rawSettings.updated_by,
      created_at: new Date(rawSettings.created_at).toISOString(),
      updated_at: new Date(rawSettings.updated_at).toISOString(),
    };

    const models: LlmModelRecord[] = modelsRes.rows.map((r: any) => ({
      model_id: r.model_id,
      nombre_visible: r.nombre_visible,
      max_output_tokens: Number(r.max_output_tokens),
      ventana_contexto: Number(r.ventana_contexto),
      precio_entrada_mtok: Number(r.precio_entrada_mtok),
      precio_salida_mtok: Number(r.precio_salida_mtok),
      disponible: Boolean(r.disponible),
      personalizado_precios: Boolean(r.personalizado_precios),
      updated_at: new Date(r.updated_at).toISOString(),
    }));

    const modelsMap: Record<string, LlmModelRecord> = {};
    for (const m of models) {
      modelsMap[m.model_id] = m;
    }

    const profiles = {} as Record<TaskName, LlmTaskProfileRecord>;
    for (const r of profilesRes.rows) {
      const t = r.tarea as TaskName;
      profiles[t] = {
        tarea: t,
        nombre_tarea: r.nombre_tarea,
        descripcion: r.descripcion,
        model: r.model || null,
        max_tokens: r.max_tokens !== null ? Number(r.max_tokens) : null,
        temperature: r.temperature !== null ? Number(r.temperature) : null,
        system_prompt: r.system_prompt || '',
        activo: Boolean(r.activo),
        updated_by: r.updated_by,
        updated_at: new Date(r.updated_at).toISOString(),
      };
    }

    return {
      settings,
      profiles,
      models,
      modelsMap,
      loadedAt: Date.now(),
      invalidationCount: this.invalidationCount,
      lastNotificationPayload: this.lastNotificationPayload,
    };
  }

  /**
   * Resuelve la configuración efectiva para una tarea específica,
   * heredando de llm_settings cualquier campo que vaya vacío en llm_task_profiles.
   */
  async getEffectiveTaskConfig(tarea: TaskName): Promise<EffectiveTaskConfig> {
    const snap = await this.getSnapshot();
    const s = snap.settings;
    const p = snap.profiles[tarea];

    const effectiveModel = p?.model || s.default_model;
    const modelInfo = snap.modelsMap[effectiveModel] || null;

    let effectiveMaxTokens = p?.max_tokens ?? s.max_tokens;
    if (modelInfo && effectiveMaxTokens > modelInfo.max_output_tokens) {
      effectiveMaxTokens = modelInfo.max_output_tokens;
    }

    const effectiveTemperature = p?.temperature !== null && p?.temperature !== undefined ? p.temperature : s.temperature;

    return {
      tarea,
      provider: s.provider,
      globalActivo: s.activo,
      tareaActiva: p ? p.activo : true,
      hasValidKey: Boolean(s.api_key_encrypted && s.api_key_encrypted.length > 0),
      apiKeyEncrypted: s.api_key_encrypted,
      apiBaseUrl: s.api_base_url,
      anthropicVersion: s.anthropic_version,
      model: effectiveModel,
      modelInfo,
      maxTokens: effectiveMaxTokens,
      temperature: effectiveTemperature,
      topP: s.top_p,
      timeoutMs: s.timeout_ms,
      maxRetries: s.max_retries,
      maxInputChars: s.max_input_chars,
      systemPrompt: p?.system_prompt || '',
      settingsVersion: s.version,
    };
  }

  /**
   * Devuelve versión segura de la configuración para enviar al frontend (nunca incluye api_key_encrypted ni la clave en claro).
   */
  async getPublicAdminSettings() {
    const snap = await this.getSnapshot();
    const { api_key_encrypted, ...safeSettings } = snap.settings;
    return {
      settings: {
        ...safeSettings,
        has_api_key: Boolean(api_key_encrypted),
        api_key_masked: formatMaskedApiKey(snap.settings.api_key_last4),
      },
      models: snap.models,
      profiles: Object.values(snap.profiles),
      cache_meta: {
        loaded_at: new Date(snap.loadedAt).toISOString(),
        invalidation_count: snap.invalidationCount,
        last_notification: snap.lastNotificationPayload,
      },
    };
  }
}

export const llmConfigCache = new LlmConfigCacheManager();
