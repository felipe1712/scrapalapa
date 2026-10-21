import { db } from '../../db/pool.js';
import { llmConfigCache } from './config.cache.js';

export interface BudgetStatus {
  tokensHoy: number;
  limiteTokensDiario: number | null;
  porcentajeTokensDiario: number | null;
  excedeTokensDiario: boolean;

  costoMesActual: number;
  limiteCostoMensual: number | null;
  porcentajeCostoMensual: number | null;
  excedeCostoMensual: boolean;

  accionLimite: 'pausar' | 'avisar';
  bloqueadoPorPresupuesto: boolean;
  avisos: string[];
}

export class LlmBudgetPausedError extends Error {
  public readonly code = 'LLM_BUDGET_PAUSED';
  constructor(message: string) {
    super(message);
    this.name = 'LlmBudgetPausedError';
  }
}

/**
 * Consulta el consumo real acumulado hoy y en el mes actual desde llm_usage,
 * comparándolo con limite_tokens_diario y limite_costo_mensual.
 */
export async function getBudgetStatus(): Promise<BudgetStatus> {
  const snap = await llmConfigCache.getSnapshot();
  const s = snap.settings;

  const dailyRes = await db.query<{ tokens_hoy: string }>(
    `SELECT COALESCE(SUM(tokens_entrada + tokens_salida + tokens_cache_creacion + tokens_cache_lectura), 0)::text AS tokens_hoy
     FROM llm_usage
     WHERE fecha >= date_trunc('day', NOW())`
  );

  const monthlyRes = await db.query<{ costo_mes: string }>(
    `SELECT COALESCE(SUM(costo_estimado), 0)::text AS costo_mes
     FROM llm_usage
     WHERE fecha >= date_trunc('month', NOW())`
  );

  const tokensHoy = Number(dailyRes.rows[0]?.tokens_hoy || 0);
  const costoMesActual = Number(monthlyRes.rows[0]?.costo_mes || 0);

  const limiteTokensDiario = s.limite_tokens_diario;
  const limiteCostoMensual = s.limite_costo_mensual;

  const excedeTokensDiario =
    limiteTokensDiario !== null && limiteTokensDiario > 0 && tokensHoy >= limiteTokensDiario;
  const excedeCostoMensual =
    limiteCostoMensual !== null && limiteCostoMensual > 0 && costoMesActual >= limiteCostoMensual;

  const porcentajeTokensDiario =
    limiteTokensDiario && limiteTokensDiario > 0
      ? Math.min(100, Number(((tokensHoy / limiteTokensDiario) * 100).toFixed(2)))
      : null;

  const porcentajeCostoMensual =
    limiteCostoMensual && limiteCostoMensual > 0
      ? Math.min(100, Number(((costoMesActual / limiteCostoMensual) * 100).toFixed(2)))
      : null;

  const avisos: string[] = [];
  if (excedeTokensDiario) {
    avisos.push(
      `Límite diario de tokens alcanzado (${tokensHoy.toLocaleString()} / ${limiteTokensDiario?.toLocaleString()} tokens).`
    );
  }
  if (excedeCostoMensual) {
    avisos.push(
      `Límite de costo mensual alcanzado ($${costoMesActual.toFixed(4)} / $${limiteCostoMensual?.toFixed(2)} USD).`
    );
  }

  const bloqueadoPorPresupuesto =
    s.accion_limite === 'pausar' && (excedeTokensDiario || excedeCostoMensual);

  return {
    tokensHoy,
    limiteTokensDiario,
    porcentajeTokensDiario,
    excedeTokensDiario,
    costoMesActual: Number(costoMesActual.toFixed(6)),
    limiteCostoMensual,
    porcentajeCostoMensual,
    excedeCostoMensual,
    accionLimite: s.accion_limite,
    bloqueadoPorPresupuesto,
    avisos,
  };
}

/**
 * Verifica el presupuesto antes de ejecutar una llamada al LLM.
 * Si la acción es 'pausar' y se alcanzó algún límite, lanza LlmBudgetPausedError.
 */
export async function assertBudgetAllowsExecution(): Promise<BudgetStatus> {
  const status = await getBudgetStatus();
  if (status.bloqueadoPorPresupuesto) {
    throw new LlmBudgetPausedError(
      `Llamadas a Claude pausadas automáticamente por presupuesto: ${status.avisos.join(' ')}`
    );
  }
  return status;
}
