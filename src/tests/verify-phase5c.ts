import http from 'node:http';
import assert from 'node:assert/strict';
import { createServerApp } from '../server.js';
import { db } from '../db/pool.js';
import { workerInstance } from '../worker/index.js';

process.env.SKIP_HTTP_LISTEN = 'true';

/**
 * Levanta un servidor mock de la API de Anthropic (/v1/messages y /v1/models)
 * para validar de extremo a extremo el SDK oficial @anthropic-ai/sdk:
 * - Clave válida vs Clave inválida (401)
 * - Rate Limit (429 con retry-after y backoff)
 * - Prompt Caching (cache_control ephemeral)
 * - Tool Use / Salida estructurada JSON validada con Zod
 * - GET /v1/models (Sincronizar modelos)
 */
function startMockAnthropicServer(): Promise<{ url: string; close: () => Promise<void>; stats: any }> {
  const stats = {
    messagesCalls: 0,
    rateLimitTriggeredOnce: false,
    lastSystemBlock: null as any,
    lastToolsBlock: null as any,
  };

  const server = http.createServer((req, res) => {
    const apiKey = req.headers['x-api-key'];

    // Validar autenticación en el servidor mock de Anthropic
    if (apiKey !== 'sk-ant-api03-valid-key-for-testing-9876') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'invalid x-api-key',
          },
        })
      );
      return;
    }

    // Endpoint GET /v1/models
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'claude-sonnet-4-20250514',
              display_name: 'Claude Sonnet 4 (Sincronizado API)',
              type: 'model',
            },
            {
              id: 'claude-3-5-haiku-20241022',
              display_name: 'Claude 3.5 Haiku (Sincronizado API)',
              type: 'model',
            },
          ],
        })
      );
      return;
    }

    // Endpoint POST /v1/messages
    if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
      let bodyStr = '';
      req.on('data', (chunk) => {
        bodyStr += chunk.toString();
      });
      req.on('end', () => {
        stats.messagesCalls += 1;
        const body = JSON.parse(bodyStr || '{}');
        stats.lastSystemBlock = body.system;
        stats.lastToolsBlock = body.tools;

        // Simular 429 Rate Limit si el prompt incluye "[SIMULATE_429]" la primera vez
        const userText = String(body.messages?.[0]?.content || '');
        if (userText.includes('[SIMULATE_429]') && !stats.rateLimitTriggeredOnce) {
          stats.rateLimitTriggeredOnce = true;
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'retry-after': '1',
          });
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message: 'Number of request tokens has exceeded your per-minute rate limit.',
              },
            })
          );
          return;
        }

        // Si la llamada usa Tool Use (salida estructurada JSON)
        if (Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice?.name) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_test_structured_01',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_01',
                  name: body.tool_choice.name,
                  input: {
                    titulo_licitacion: 'Suministro de Servidores de Cómputo de Alto Rendimiento',
                    entidad_convocante: 'Secretaría de Infraestructura',
                    presupuesto_estimado: 4850000,
                    moneda: 'MXN',
                    fecha_limite_propuestas: '2026-11-15',
                    requisitos_clave: ['Certificación ISO 9001', 'Garantía 36 meses'],
                    nivel_riesgo: 'bajo',
                  },
                },
              ],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: {
                input_tokens: 185,
                output_tokens: 92,
                cache_creation_input_tokens: 120,
                cache_read_input_tokens: 120,
              },
            })
          );
          return;
        }

        // Llamada estándar de texto (ej. "Probar conexión")
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_test_ping_01',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: 'CONEXION_OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 14,
              output_tokens: 4,
            },
          })
        );
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        stats,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function runVerification() {
  console.log('====================================================================');
  console.log('🧪 INICIANDO VERIFICACIÓN AUTOMATIZADA — FASE 5c (CLAUDE API + PG)');
  console.log('====================================================================\n');

  const mockAnthropic = await startMockAnthropicServer();
  const app = await createServerApp();

  const apiServer = http.createServer(app);
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', () => r()));
  const apiPort = (apiServer.address() as any).port;
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  try {
    // 1. Verificar protección por rol admin (RBAC)
    console.log('1️⃣  Verificando protección de endpoints por rol admin...');
    const forbiddenRes = await fetch(`${apiUrl}/api/settings/llm`, {
      headers: { 'x-user-role': 'operador' },
    });
    assert.equal(forbiddenRes.status, 403, 'Rol no-admin debe recibir 403 Forbidden');
    console.log('   ✅ Rol operador bloqueado correctamente con 403 Forbidden.\n');

    // 2. Probar conexión con clave INVÁLIDA (sin guardar aún)
    console.log('2️⃣  Verificando botón "Probar conexión" con clave INVÁLIDA...');
    const badTestRes = await fetch(`${apiUrl}/api/settings/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({
        api_key: 'sk-ant-api03-clave-incorrecta-0000',
        api_base_url: mockAnthropic.url,
        model: 'claude-sonnet-4-20250514',
        max_tokens: 32,
      }),
    });
    const badTestBody = (await badTestRes.json()) as any;
    assert.equal(badTestBody.ok, false, 'Prueba con clave inválida debe devolver ok=false');
    assert.equal(badTestBody.error_code, 'AUTHENTICATION_ERROR');
    assert.match(badTestBody.error_message, /Clave de API inválida/i);
    console.log(`   ✅ Error traducido claramente: "${badTestBody.error_message}"\n`);

    // 3. Probar conexión con clave VÁLIDA desde el formulario (aún sin guardar en BD)
    console.log('3️⃣  Verificando botón "Probar conexión" con clave VÁLIDA (en tránsito)...');
    const goodTestRes = await fetch(`${apiUrl}/api/settings/llm/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({
        api_key: 'sk-ant-api03-valid-key-for-testing-9876',
        api_base_url: mockAnthropic.url,
        model: 'claude-sonnet-4-20250514',
        max_tokens: 32,
      }),
    });
    const goodTestBody = (await goodTestRes.json()) as any;
    assert.equal(goodTestBody.ok, true, 'Prueba con clave válida debe devolver ok=true');
    assert.equal(goodTestBody.model, 'claude-sonnet-4-20250514');
    assert.ok(goodTestBody.usage.total_tokens > 0);
    console.log(
      `   ✅ Conexión exitosa: Modelo=${goodTestBody.model}, Latencia=${goodTestBody.latency_ms}ms, Tokens=${goodTestBody.usage.total_tokens}\n`
    );

    // 4. Guardar configuración en PostgreSQL y verificar cifrado AES-256-GCM y enmascarado
    console.log('4️⃣  Guardando configuración y verificando cifrado AES-256-GCM + máscara sk-ant-…XXXX...');
    const saveRes = await fetch(`${apiUrl}/api/settings/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({
        activo: true,
        api_key: 'sk-ant-api03-valid-key-for-testing-9876',
        api_base_url: mockAnthropic.url,
        anthropic_version: '2023-06-01',
        default_model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature: 0.2,
        timeout_ms: 30000,
        max_retries: 2,
        max_input_chars: 80000,
        limite_tokens_diario: 500000,
        limite_costo_mensual: 150,
        accion_limite: 'avisar',
      }),
    });
    const saveBody = (await saveRes.json()) as any;
    assert.equal(saveBody.ok, true);
    assert.equal(saveBody.settings.api_key_masked, 'sk-ant-…9876');
    assert.equal(saveBody.settings.api_key_encrypted, undefined, 'Jamás debe regresar el texto cifrado ni plano al frontend');

    const dbRow = await db.query('SELECT api_key_encrypted, api_key_last4 FROM llm_settings LIMIT 1');
    assert.equal(dbRow.rows[0].api_key_last4, '9876');
    assert.ok(
      !String(dbRow.rows[0].api_key_encrypted).includes('valid-key-for-testing'),
      'La clave en PostgreSQL debe estar cifrada con AES-256-GCM'
    );
    console.log(`   ✅ Clave cifrada en BD y expuesta únicamente como "${saveBody.settings.api_key_masked}".\n`);

    // 5. Criterio Fase 5c: Cambiar modelo o max_tokens desde la UI se refleja en la siguiente llamada SIN REINICIAR
    console.log('5️⃣  Verificando Hot-Reload (NOTIFY/LISTEN): cambio de modelo y max_tokens sin reiniciar...');
    const hotUpdateRes = await fetch(`${apiUrl}/api/settings/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({
        activo: true,
        api_base_url: mockAnthropic.url,
        anthropic_version: '2023-06-01',
        default_model: 'claude-3-5-haiku-20241022',
        max_tokens: 1536,
        temperature: 0.1,
        timeout_ms: 30000,
        max_retries: 2,
        max_input_chars: 80000,
        accion_limite: 'avisar',
      }),
    });
    const hotUpdateBody = (await hotUpdateRes.json()) as any;
    assert.equal(hotUpdateBody.ok, true);

    // Actualizar también el perfil completar_campos para que herede max_tokens (null)
    await fetch(`${apiUrl}/api/settings/llm/profiles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({
        profiles: [
          {
            tarea: 'completar_campos',
            model: null, // Hereda default_model ('claude-3-5-haiku-20241022')
            max_tokens: null, // Hereda max_tokens (1536)
            temperature: null,
            system_prompt: 'Extrae datos de licitación en formato JSON estructurado.',
            activo: true,
          },
        ],
      }),
    });

    const nextCallCfgRes = await fetch(`${apiUrl}/api/llm/effective-config/completar_campos`);
    const nextCallCfg = (await nextCallCfgRes.json()) as any;
    assert.equal(nextCallCfg.effective.model, 'claude-3-5-haiku-20241022');
    assert.equal(nextCallCfg.effective.maxTokens, 1536);

    // Ejecutar el Worker inmediatamente sin reiniciar y verificar extracción estructurada Zod + Prompt Caching + Backoff 429
    const workerResult = await workerInstance.processTenderDocument(
      'TND-HOT-RELOAD-01',
      'DOC-01',
      'Convocatoria de licitación pública [SIMULATE_429] para suministro de servidores.'
    );
    assert.equal(workerResult.ok, true);
    assert.equal(workerResult.model, 'claude-3-5-haiku-20241022');
    assert.equal(workerResult.data?.moneda, 'MXN');
    assert.equal(
      mockAnthropic.stats.lastSystemBlock?.[0]?.cache_control?.type,
      'ephemeral',
      'Debe usar Prompt Caching en el bloque system'
    );
    assert.equal(
      mockAnthropic.stats.lastToolsBlock?.[0]?.cache_control?.type,
      'ephemeral',
      'Debe usar Prompt Caching en el esquema de tools'
    );
    console.log(
      `   ✅ Siguiente llamada reflejó el cambio al instante (Modelo=${workerResult.model}, max_tokens=${nextCallCfg.effective.maxTokens}) con Prompt Caching, Tool Use + Zod y recuperación ante HTTP 429.\n`
    );

    // 6. Sincronizar modelos desde GET /v1/models
    console.log('6️⃣  Verificando sincronización de modelos (POST /api/settings/llm/models/sync)...');
    const syncRes = await fetch(`${apiUrl}/api/settings/llm/models/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({}),
    });
    const syncBody = (await syncRes.json()) as any;
    assert.equal(syncBody.ok, true);
    assert.equal(syncBody.syncedCount, 2);
    console.log(`   ✅ Catálogo sincronizado desde GET /v1/models (${syncBody.syncedCount} modelos).\n`);

    // 7. Verificar Panel de Consumo y exportación CSV (GET /api/settings/llm/usage)
    console.log('7️⃣  Verificando bitácora llm_usage y exportación CSV...');
    const usageJsonRes = await fetch(`${apiUrl}/api/settings/llm/usage`, {
      headers: { 'x-user-role': 'admin' },
    });
    const usageJson = (await usageJsonRes.json()) as any;
    assert.equal(usageJson.ok, true);
    assert.ok(usageJson.recent_logs.length >= 2);

    const usageCsvRes = await fetch(`${apiUrl}/api/settings/llm/usage?format=csv`, {
      headers: { 'x-user-role': 'admin' },
    });
    const csvText = await usageCsvRes.text();
    assert.match(csvText, /id,fecha,tarea,modelo,tokens_entrada/);
    console.log(`   ✅ Panel de consumo y exportación CSV verificados (${usageJson.recent_logs.length} llamadas en bitácora).\n`);

    // 8. Verificar regla de Fallback al deshabilitar LLM o eliminar clave (Surya + reglas sigue funcionando)
    console.log('8️⃣  Verificando fallback limpio al pipeline local (Surya + reglas) cuando el LLM se desactiva...');
    await fetch(`${apiUrl}/api/settings/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({
        activo: false,
        api_base_url: mockAnthropic.url,
        anthropic_version: '2023-06-01',
        default_model: 'claude-3-5-haiku-20241022',
        max_tokens: 1536,
        timeout_ms: 30000,
        max_retries: 2,
        max_input_chars: 80000,
        accion_limite: 'avisar',
      }),
    });

    const statusDisabledRes = await fetch(`${apiUrl}/api/llm/status`);
    const statusDisabled = (await statusDisabledRes.json()) as any;
    assert.equal(statusDisabled.ready, false);
    assert.equal(statusDisabled.local_pipeline.status, 'active');

    const fallbackExecRes = await fetch(`${apiUrl}/api/llm/execute-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tarea: 'completar_campos' }),
    });
    const fallbackExec = (await fallbackExecRes.json()) as any;
    assert.equal(fallbackExec.ok, true);
    assert.equal(fallbackExec.mode, 'local_pipeline_surya_rules');
    console.log(`   ✅ Funciones IA desactivadas con aviso y pipeline local activo (${fallbackExec.local_extraction.motor}).\n`);

    // Restaurar URL base oficial de Anthropic y configuración limpia lista para usar en la UI
    await fetch(`${apiUrl}/api/settings/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-user-role': 'admin' },
      body: JSON.stringify({
        activo: true,
        remove_api_key: true,
        api_base_url: 'https://api.anthropic.com',
        anthropic_version: '2023-06-01',
        default_model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        temperature: 0.2,
        timeout_ms: 60000,
        max_retries: 3,
        max_input_chars: 120000,
        limite_tokens_diario: 500000,
        limite_costo_mensual: 100,
        accion_limite: 'avisar',
      }),
    });

    console.log('====================================================================');
    console.log('🎉 TODAS LAS PRUEBAS DE LA FASE 5c PASARON EXITOSAMENTE');
    console.log('====================================================================');
  } finally {
    await new Promise<void>((r) => apiServer.close(() => r()));
    await mockAnthropic.close();
  }
}

runVerification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Falló la verificación:', err);
    process.exit(1);
  });
