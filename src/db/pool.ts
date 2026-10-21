import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { env } from '../config/env.js';

export interface QueryResultRow {
  [column: string]: any;
}

export interface DbQueryResult<R extends QueryResultRow = any> {
  rows: R[];
  rowCount: number;
}

type NotifyCallback = (payload: string) => void;

class DatabaseManager {
  private pgPool: pg.Pool | null = null;
  private pgListenClient: pg.Client | null = null;
  private pglite: PGlite | null = null;
  private mode: 'pg' | 'pglite' | null = null;
  private initPromise: Promise<void> | null = null;
  private listeners: Map<string, Set<NotifyCallback>> = new Map();
  private ipcFilePath = path.resolve(process.cwd(), 'data', '.llm_config_signal');
  private lastSignalMtime = 0;
  private watcherInterval: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    // 1. Intentar conexión a PostgreSQL externo si DATABASE_URL está configurado
    if (process.env.FORCE_EXTERNAL_PG === 'true' || env.DATABASE_URL) {
      try {
        const testPool = new pg.Pool({
          connectionString: env.DATABASE_URL,
          connectionTimeoutMillis: 2500,
        });
        await testPool.query('SELECT 1');
        this.pgPool = testPool;
        this.mode = 'pg';
        console.log('[DB] Conectado a PostgreSQL servidor externo via DATABASE_URL.');
        await this.setupExternalPgListener();
        return;
      } catch (err: any) {
        if (err?.code === '3D000') {
          try {
            const parsedUrl = new URL(env.DATABASE_URL);
            const targetDbName = parsedUrl.pathname.replace(/^\//, '') || 'scrapper_db';
            parsedUrl.pathname = '/postgres';
            const adminClient = new pg.Client({
              connectionString: parsedUrl.toString(),
              connectionTimeoutMillis: 2500,
            });
            await adminClient.connect();
            await adminClient.query(`CREATE DATABASE "${targetDbName.replace(/"/g, '')}"`);
            await adminClient.end();
            console.log(`[DB] Base de datos PostgreSQL "${targetDbName}" creada automáticamente.`);

            const retryPool = new pg.Pool({
              connectionString: env.DATABASE_URL,
              connectionTimeoutMillis: 2500,
            });
            await retryPool.query('SELECT 1');
            this.pgPool = retryPool;
            this.mode = 'pg';
            console.log('[DB] Conectado a PostgreSQL servidor externo via DATABASE_URL.');
            await this.setupExternalPgListener();
            return;
          } catch (createErr: any) {
            console.warn('[DB] No se pudo crear automáticamente la BD en PG externo:', createErr?.message);
          }
        }
        if (process.env.FORCE_EXTERNAL_PG === 'true') {
          throw err;
        }
        console.log(
          `[DB] PostgreSQL externo no accesible con credenciales actuales (${err?.code || err?.message}). ` +
            `Iniciando motor PostgreSQL embebido persistente (PGlite en ./data/pgdata)...`
        );
      }
    }

    // 2. Motor PostgreSQL 16 embebido persistente (PGlite) con soporte completo de PL/pgSQL y LISTEN/NOTIFY
    const dataDir = path.resolve(process.cwd(), 'data', 'pgdata');
    fs.mkdirSync(dataDir, { recursive: true });
    this.pglite = new PGlite(dataDir);
    await this.pglite.waitReady;
    this.mode = 'pglite';
    console.log('[DB] Motor PostgreSQL (PGlite persistente) listo en ./data/pgdata.');

    await this.setupPgliteListener();
  }

  private async setupExternalPgListener(): Promise<void> {
    if (!this.pgPool) return;
    try {
      this.pgListenClient = new pg.Client({ connectionString: env.DATABASE_URL });
      await this.pgListenClient.connect();
      this.pgListenClient.on('notification', (msg) => {
        const callbacks = this.listeners.get(msg.channel);
        if (callbacks) {
          for (const cb of callbacks) {
            cb(msg.payload || '');
          }
        }
      });
      this.pgListenClient.on('error', (err) => {
        console.error('[DB LISTEN] Error en cliente LISTEN:', err.message);
      });
      for (const channel of this.listeners.keys()) {
        await this.pgListenClient.query(`LISTEN ${channel}`);
      }
    } catch (err: any) {
      console.error('[DB LISTEN] No se pudo iniciar cliente LISTEN:', err.message);
    }
  }

  private async setupPgliteListener(): Promise<void> {
    if (!this.pglite) return;
    for (const [channel] of this.listeners.entries()) {
      await this.pglite.listen(channel, (payload) => {
        this.dispatchChannel(channel, payload);
      });
    }

    // Señal IPC ligera adicional para sincronizar API y Worker si corren en procesos separados con PGlite
    const signalDir = path.dirname(this.ipcFilePath);
    fs.mkdirSync(signalDir, { recursive: true });
    if (!fs.existsSync(this.ipcFilePath)) {
      fs.writeFileSync(this.ipcFilePath, JSON.stringify({ ts: Date.now() }), 'utf8');
    }
    this.lastSignalMtime = fs.statSync(this.ipcFilePath).mtimeMs;

    this.watcherInterval = setInterval(() => {
      try {
        if (!fs.existsSync(this.ipcFilePath)) return;
        const stat = fs.statSync(this.ipcFilePath);
        if (stat.mtimeMs > this.lastSignalMtime) {
          this.lastSignalMtime = stat.mtimeMs;
          const raw = fs.readFileSync(this.ipcFilePath, 'utf8');
          this.dispatchChannel('llm_config_changed', raw);
        }
      } catch {
        // Ignorar errores transitorios de lectura
      }
    }, 350);
    this.watcherInterval.unref();
  }

  private dispatchChannel(channel: string, payload: string): void {
    const callbacks = this.listeners.get(channel);
    if (!callbacks) return;
    for (const cb of callbacks) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[DB NOTIFY] Error en callback del canal ${channel}:`, err);
      }
    }
  }

  async query<R extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<DbQueryResult<R>> {
    await this.init();
    if (this.mode === 'pg' && this.pgPool) {
      const res = await this.pgPool.query<R>(sql, params);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    }
    if (this.pglite) {
      const res = await this.pglite.query<R>(sql, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    }
    throw new Error('Base de datos no inicializada.');
  }

  async execSqlScript(sqlScript: string): Promise<void> {
    await this.init();
    if (this.mode === 'pg' && this.pgPool) {
      await this.pgPool.query(sqlScript);
      return;
    }
    if (this.pglite) {
      await this.pglite.exec(sqlScript);
      return;
    }
    throw new Error('Base de datos no inicializada.');
  }

  async listen(channel: string, callback: NotifyCallback): Promise<void> {
    await this.init();
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
      if (this.mode === 'pg' && this.pgListenClient) {
        await this.pgListenClient.query(`LISTEN ${channel}`);
      } else if (this.mode === 'pglite' && this.pglite) {
        await this.pglite.listen(channel, (payload) => {
          this.dispatchChannel(channel, payload);
        });
      }
    }
    this.listeners.get(channel)!.add(callback);
  }

  async notify(channel: string, payloadObj: Record<string, any>): Promise<void> {
    await this.init();
    const payload = JSON.stringify({ ...payloadObj, timestamp: Date.now() });
    await this.query(`SELECT pg_notify($1, $2)`, [channel, payload]);

    if (this.mode === 'pglite') {
      try {
        fs.writeFileSync(this.ipcFilePath, payload, 'utf8');
        this.lastSignalMtime = fs.statSync(this.ipcFilePath).mtimeMs;
      } catch {
        // ignore
      }
    }
  }

  getMode(): string {
    return this.mode || 'uninitialized';
  }
}

export const db = new DatabaseManager();
