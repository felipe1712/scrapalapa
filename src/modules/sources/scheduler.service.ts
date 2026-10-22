import { db } from '../../db/pool.js';
import { decryptApiKey } from '../llm/crypto.service.js';
import { tenderIngestionService } from '../tenders/tender-ingestion.service.js';

export class SourcesSchedulerService {
  private isLoopRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private runningSourceIds = new Set<number>();

  /**
   * Inicia el reloj automático que verifica cada 60 segundos si hay fuentes activas
   * cuya proxima_revision_at ya se cumplió.
   */
  startScheduler(intervalMs = 60_000): void {
    if (this.timer) return;
    console.log(`[Scheduler] Agente automático de Fuentes de Interés iniciado (intervalo: ${intervalMs / 1000}s)`);

    this.timer = setInterval(() => {
      this.checkAndRunDueSources().catch((err) => {
        console.error('[Scheduler] Error en ciclo programado:', err?.message || err);
      });
    }, intervalMs);
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Busca todas las fuentes activas cuya proxima_revision_at <= NOW() y las ejecuta secuencialmente.
   */
  async checkAndRunDueSources(): Promise<void> {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;

    try {
      const dueRes = await db.query(
        `SELECT id FROM scraping_sources
         WHERE activo = true
           AND ultimo_estado <> 'ejecutando'
           AND (proxima_revision_at IS NULL OR proxima_revision_at <= NOW())
         ORDER BY proxima_revision_at ASC NULLS FIRST
         LIMIT 5`
      );

      for (const row of dueRes.rows) {
        await this.runSourceById(Number(row.id), 'programado');
      }
    } finally {
      this.isLoopRunning = false;
    }
  }

  /**
   * Ejecuta todas las fuentes activas inmediatamente (disparo manual desde la UI).
   */
  async runAllActiveSources(): Promise<{ startedCount: number }> {
    const res = await db.query(
      `SELECT id FROM scraping_sources WHERE activo = true ORDER BY id ASC`
    );
    const ids = res.rows.map((r) => Number(r.id));

    // Ejecutar en segundo plano de forma secuencial para no saturar CPU/red
    (async () => {
      for (const id of ids) {
        await this.runSourceById(id, 'manual');
      }
    })().catch((err) => {
      console.error('[Scheduler] Error en corrida masiva:', err?.message || err);
    });

    return { startedCount: ids.length };
  }

  /**
   * Ejecuta una fuente específica con aislamiento completo de errores (try/catch + timeout).
   */
  async runSourceById(sourceId: number, disparo: 'programado' | 'manual' = 'manual') {
    if (this.runningSourceIds.has(sourceId)) {
      return {
        ok: false,
        message: 'Esta fuente ya se encuentra en ejecución en este momento.',
      };
    }

    const srcRes = await db.query('SELECT * FROM scraping_sources WHERE id = $1 LIMIT 1', [sourceId]);
    if (srcRes.rowCount === 0) {
      return { ok: false, message: 'Fuente no encontrada.' };
    }

    const source = srcRes.rows[0];
    this.runningSourceIds.add(sourceId);
    const startTime = Date.now();

    // Crear registro en bitácora scraping_runs
    const runInsert = await db.query<{ id: number }>(
      `INSERT INTO scraping_runs (source_id, disparo, estado, mensaje_log)
       VALUES ($1, $2, 'ejecutando', 'Iniciando revisión del portal...')
       RETURNING id`,
      [sourceId, disparo]
    );
    const runId = runInsert.rows[0].id;

    await db.query(
      `UPDATE scraping_sources
       SET ultimo_estado = 'ejecutando',
           ultimo_mensaje = 'Revisando portal y buscando coincidencias...',
           updated_at = NOW()
       WHERE id = $1`,
      [sourceId]
    );

    try {
      let plainPassword: string | undefined;
      if (source.requiere_auth && source.auth_password_encrypted) {
        plainPassword = decryptApiKey(source.auth_password_encrypted) || undefined;
      }

      const ingestPromise = tenderIngestionService.ingestFromUrl({
        url: source.url,
        keywords: source.keywords,
        ocrMode: 'auto',
        processAttachments: true,
        maxAttachments: 8,
        authUsername: source.requiere_auth ? source.auth_username || undefined : undefined,
        authPassword: plainPassword,
        authLoginUrl: source.requiere_auth ? source.auth_login_url || undefined : undefined,
        sourceId: source.id,
        defaultEntidad: source.entidad || source.nombre,
        skipIfDuplicate: disparo === 'programado', // En programado omite duplicados; en manual o primera vez guarda si es nueva
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tiempo máximo de ejecución por fuente agotado (180s)')), 180_000)
      );

      const result = await Promise.race([ingestPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      const hitsCount = Number(result.hitsCount || 0);
      const newCount = Number(result.newTendersCount || 0);
      const dupCount = Number(result.duplicateTendersCount || 0);

      let summaryMsg = '';
      if (result.skippedNoHits) {
        summaryMsg = `Sin coincidencias para "${source.keywords}".`;
      } else if (result.skippedDuplicate) {
        summaryMsg = `${hitsCount} coincidencia(s) revisada(s) — ya registradas previamente (0 nuevas).`;
      } else {
        summaryMsg = `${newCount} nueva(s) licitación(es) guardada(s) con ${hitsCount} coincidencia(s).`;
      }

      await db.query(
        `UPDATE scraping_runs SET
          estado = 'exito',
          hits_detectados = $1,
          licitaciones_nuevas = $2,
          licitaciones_duplicadas = $3,
          duracion_ms = $4,
          mensaje_log = $5
         WHERE id = $6`,
        [hitsCount, newCount, dupCount, durationMs, summaryMsg, runId]
      );

      await db.query(
        `UPDATE scraping_sources SET
          ultima_revision_at = NOW(),
          proxima_revision_at = NOW() + ($1 || ' hours')::interval,
          ultimo_estado = 'exito',
          ultimo_mensaje = $2,
          total_licitaciones_encontradas = total_licitaciones_encontradas + $3,
          updated_at = NOW()
         WHERE id = $4`,
        [String(source.frecuencia_horas || 24), summaryMsg, newCount, sourceId]
      );

      return {
        ok: true,
        runId,
        hitsCount,
        newCount,
        dupCount,
        durationMs,
        message: summaryMsg,
        tender: (result as any).tender || null,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errMsg = err?.message || String(err);

      await db.query(
        `UPDATE scraping_runs SET
          estado = 'error',
          duracion_ms = $1,
          mensaje_log = 'Error durante la revisión del portal',
          error_detalle = $2
         WHERE id = $3`,
        [durationMs, errMsg, runId]
      );

      await db.query(
        `UPDATE scraping_sources SET
          ultima_revision_at = NOW(),
          proxima_revision_at = NOW() + ($1 || ' hours')::interval,
          ultimo_estado = 'error',
          ultimo_mensaje = $2,
          updated_at = NOW()
         WHERE id = $3`,
        [String(source.frecuencia_horas || 24), `Error: ${errMsg.slice(0, 220)}`, sourceId]
      );

      return {
        ok: false,
        runId,
        message: errMsg,
      };
    } finally {
      this.runningSourceIds.delete(sourceId);
    }
  }
}

export const sourcesSchedulerService = new SourcesSchedulerService();
