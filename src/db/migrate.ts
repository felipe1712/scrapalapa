import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    await db.execSqlScript(sql);
    console.log(`[Migrations] Aplicada migración: ${file}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  runMigrations()
    .then(() => {
      console.log('[Migrations] Todas las migraciones completadas con éxito.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migrations] Error al ejecutar migraciones:', err);
      process.exit(1);
    });
}
