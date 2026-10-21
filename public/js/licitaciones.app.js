/**
 * Scrapper — Licitaciones & Pipeline
 */
(function () {
  'use strict';

  async function loadPipelineStatus() {
    try {
      const res = await fetch('/api/llm/status');
      const status = await res.json();

      const sidebarBadge = document.getElementById('sidebarLlmStatusBadge');
      const modelBadge = document.getElementById('activeModelBadge');
      const warnBanner = document.getElementById('pipelineWarningBanner');
      const warnText = document.getElementById('pipelineWarningText');
      const aiButtons = document.querySelectorAll('.task-exec-btn');

      if (modelBadge) {
        modelBadge.textContent = `Modelo: ${status.default_model} · max_tokens: ${status.max_tokens}`;
      }

      if (status.ready) {
        if (sidebarBadge) {
          sidebarBadge.className = 'badge bg-success';
          sidebarBadge.textContent = 'Activo';
        }
        warnBanner?.classList.add('d-none');
        aiButtons.forEach((btn) => {
          btn.disabled = false;
          btn.classList.remove('opacity-50');
        });
      } else {
        if (sidebarBadge) {
          sidebarBadge.className = 'badge bg-secondary';
          sidebarBadge.textContent = !status.llm_enabled ? 'Deshabilitado' : 'Sin API Key';
        }
        warnBanner?.classList.remove('d-none');
        if (warnText) {
          warnText.textContent =
            status.warning_message ||
            'El módulo LLM no está activo. Las funciones de IA están deshabilitadas y el pipeline local sigue funcionando.';
        }
        aiButtons.forEach((btn) => {
          btn.disabled = true;
          btn.classList.add('opacity-50');
        });
      }
    } catch {
      // ignore
    }
  }

  async function executeTask(tarea) {
    const out = document.getElementById('taskOutputPre');
    const badge = document.getElementById('execMetricsBadge');
    const texto = document.getElementById('tenderTextInput')?.value || '';
    const tenderId = document.getElementById('tenderIdInput')?.value || 'TND-01';
    const documentId = document.getElementById('documentIdInput')?.value || 'DOC-01';

    if (out) out.textContent = `Procesando tarea "${tarea}"...`;
    badge?.classList.add('d-none');

    try {
      const res = await fetch('/api/llm/execute-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tarea,
          texto,
          tender_id: tenderId,
          document_id: documentId,
        }),
      });
      const data = await res.json();

      if (data.result?.latencyMs) {
        badge?.classList.remove('d-none');
        badge.textContent = `${data.result.model} · ${data.result.latencyMs} ms · $${Number(
          data.result.usage?.estimatedCostUsd || 0
        ).toFixed(5)} USD`;
      }

      if (out) {
        out.textContent = JSON.stringify(data, null, 2);
      }
    } catch (err) {
      if (out) out.textContent = 'Error al ejecutar tarea: ' + err.message;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadPipelineStatus();

    document.querySelectorAll('.task-exec-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tarea = btn.getAttribute('data-task') || 'completar_campos';
        executeTask(tarea);
      });
    });

    document.getElementById('btnRunLocalPipeline')?.addEventListener('click', () => {
      const out = document.getElementById('taskOutputPre');
      const texto = document.getElementById('tenderTextInput')?.value || '';
      const montoMatch = texto.match(/\$([0-9,]+(\.[0-9]{2})?)/);
      const fechaMatch = texto.match(/20\d{2}-\d{2}-\d{2}/);
      const licMatch = texto.match(/LA-[0-9A-Z-]+/);

      const localResult = {
        ok: true,
        mode: 'local_pipeline_surya_rules',
        motor: 'Surya OCR + Motor de Reglas Deterministas',
        extraccion_local: {
          numero_licitacion: licMatch ? licMatch[0] : 'Detectado por regla local',
          monto_detectado: montoMatch ? montoMatch[0] : null,
          fecha_detectada: fechaMatch ? fechaMatch[0] : null,
          longitud_texto: texto.length,
        },
      };
      if (out) out.textContent = JSON.stringify(localResult, null, 2);
    });
  });
})();
