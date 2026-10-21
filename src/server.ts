import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { seedInitialLlmConfig } from './db/seed.js';
import { llmConfigCache } from './modules/llm/config.cache.js';
import { llmSettingsRouter, llmPublicRouter } from './modules/llm/llm.routes.js';
import { workerInstance } from './worker/index.js';

export async function createServerApp() {
  await runMigrations();
  await seedInitialLlmConfig();
  await llmConfigCache.initListener();
  await workerInstance.start();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Servir los assets originales de la plantilla WinDOORS (C:\Users\DELL\Documents\Scrapper\template\assets)
  const templateAssetsDir = path.resolve(process.cwd(), 'template', 'assets');
  const publicDir = path.resolve(process.cwd(), 'public');

  app.use('/assets', express.static(templateAssetsDir));
  app.use(express.static(publicDir));
  app.use('/template', express.static(path.resolve(process.cwd(), 'template')));

  // Rutas API protegidas por rol admin (/api/settings/llm/*)
  app.use('/api/settings/llm', llmSettingsRouter);

  // Rutas de estado y ejecución de pipeline (/api/llm/*)
  app.use('/api/llm', llmPublicRouter);

  // Redirección raíz a la pantalla de Configuración -> Inteligencia artificial (Claude) o Dashboard
  app.get('/', (_req, res) => {
    res.redirect('/settings-llm.html');
  });

  return app;
}

const __filename = fileURLToPath(import.meta.url);
const isDirectMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectMain && process.env.SKIP_HTTP_LISTEN !== 'true') {
  createServerApp()
    .then((app) => {
      app.listen(env.PORT, () => {
        console.log(`================================================================================`);
        console.log(`🚀 Servidor Scrapper + Módulo LLM Claude (Fase 5c) activo en http://localhost:${env.PORT}`);
        console.log(`⚙️  Pantalla Admin WinDOORS: http://localhost:${env.PORT}/settings-llm.html`);
        console.log(`================================================================================`);
      });
    })
    .catch((err) => {
      console.error('Error al iniciar el servidor:', err);
      process.exit(1);
    });
}
