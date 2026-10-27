import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { seedInitialLlmConfig } from './db/seed.js';
import { llmConfigCache } from './modules/llm/config.cache.js';
import { llmSettingsRouter, llmPublicRouter } from './modules/llm/llm.routes.js';
import { tendersRouter } from './modules/tenders/tenders.routes.js';
import { sourcesRouter } from './modules/sources/sources.routes.js';
import { sourcesSchedulerService } from './modules/sources/scheduler.service.js';
import { authService } from './modules/auth/auth.service.js';
import { attachSessionMiddleware } from './modules/auth/auth.middleware.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { emailRouter } from './modules/email/email.routes.js';
import { emailMonitorService } from './modules/email/email-monitor.service.js';
import { workerInstance } from './worker/index.js';

export async function createServerApp() {
  await runMigrations();
  await seedInitialLlmConfig();
  await authService.ensureInitialSuperAdmin();
  await llmConfigCache.initListener();
  await workerInstance.start();
  sourcesSchedulerService.startScheduler(60_000);
  emailMonitorService.startScheduler(60_000);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(attachSessionMiddleware);

  // Protección de páginas HTML principales: si no hay sesión activa, redirigir a /login.html
  const protectedHtmlPages = new Set([
    '/',
    '/licitaciones.html',
    '/fuentes.html',
    '/settings-llm.html',
    '/administracion.html',
  ]);
  app.use((req, res, next) => {
    if (req.method === 'GET' && protectedHtmlPages.has(req.path)) {
      if (!req.auth) {
        res.redirect('/login.html');
        return;
      }
      if (req.path === '/') {
        res.redirect('/licitaciones.html');
        return;
      }
    }
    if (req.method === 'GET' && req.path === '/login.html' && req.auth) {
      res.redirect('/licitaciones.html');
      return;
    }
    next();
  });

  // Servir los assets originales de la plantilla WinDOORS (C:\Users\DELL\Documents\Scrapper\template\assets)
  const templateAssetsDir = path.resolve(process.cwd(), 'template', 'assets');
  const publicDir = path.resolve(process.cwd(), 'public');

  app.use('/assets', express.static(templateAssetsDir));
  app.use(express.static(publicDir));
  app.use('/template', express.static(path.resolve(process.cwd(), 'template')));

  // Rutas de autenticación y sesión (/api/auth/*)
  app.use('/api/auth', authRouter);

  // Rutas de Administración Multitenant: Clientes, Usuarios y Actividad (/api/admin/*)
  app.use('/api/admin', adminRouter);

  // Rutas de Monitoreo Automático de Correo Electrónico "Correo E" (/api/email-accounts/*)
  app.use('/api/email-accounts', emailRouter);

  // Rutas API protegidas por rol admin (/api/settings/llm/*)
  app.use('/api/settings/llm', llmSettingsRouter);

  // Rutas de estado y ejecución de pipeline (/api/llm/*)
  app.use('/api/llm', llmPublicRouter);

  // Rutas de ingesta y análisis de licitaciones por URL (Lightpanda + Surya + Claude)
  app.use('/api/tenders', tendersRouter);

  // Rutas de administración y monitoreo automático de Fuentes de Interés (/api/sources/*)
  app.use('/api/sources', sourcesRouter);

  // Redirección raíz
  app.get('/', (_req, res) => {
    res.redirect('/licitaciones.html');
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
