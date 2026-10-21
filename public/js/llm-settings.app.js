/**
 * Scrapper — Configuración -> Inteligencia artificial (Claude)
 */
(function () {
  'use strict';

  const state = {
    role: 'admin',
    settings: null,
    models: [],
    modelsMap: {},
    profiles: [],
    budget: null,
    history: [],
    replacingKey: false,
    removeKeyRequested: false,
    lastUsageData: null,
    charts: {
      byDay: null,
      byTask: null,
    },
  };

  const TAB_HASH_MAP = {
    '#conexion': '#tab-general',
    '#perfiles': '#tab-profiles',
    '#consumo': '#tab-usage',
    '#historial': '#tab-history',
  };

  function getAuthHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-user-role': 'admin',
      'x-user-name': 'admin@scrapper.local',
    };
  }

  function showGlobalFeedback(message, type = 'success') {
    const el = document.getElementById('globalFeedbackAlert');
    if (!el) return;
    el.className = `alert alert-${type} border-0 shadow-sm mb-3`;
    el.innerHTML = `<div class="d-flex align-items-center justify-content-between">
      <span><i class="bi ${type === 'success' ? 'bi-check-circle-fill' : 'bi-exclamation-octagon-fill'} me-2"></i>${message}</span>
      <button type="button" class="btn-close" onclick="this.parentElement.parentElement.classList.add('d-none')"></button>
    </div>`;
    el.classList.remove('d-none');
  }

  /**
   * Activa una pestaña por su selector de panel (#tab-general, #tab-profiles, #tab-usage, #tab-history)
   * o por su hash (#conexion, #perfiles, #consumo, #historial) y actualiza el URL.
   */
  function activateTab(hashOrTarget, updateUrl = true) {
    const targetPaneSelector = TAB_HASH_MAP[hashOrTarget] || hashOrTarget || '#tab-general';
    const tabLinks = document.querySelectorAll('#llmAdminTabs .nav-link');
    const tabPanes = document.querySelectorAll('#llmAdminTabsContent .tab-pane');

    let matchedHash = '#conexion';
    tabLinks.forEach((link) => {
      const linkTarget = link.getAttribute('data-tab-target');
      const linkHash = link.getAttribute('href');
      if (linkTarget === targetPaneSelector || linkHash === hashOrTarget) {
        link.classList.add('active');
        link.setAttribute('aria-selected', 'true');
        if (linkHash) matchedHash = linkHash;
      } else {
        link.classList.remove('active');
        link.setAttribute('aria-selected', 'false');
      }
    });

    tabPanes.forEach((pane) => {
      if ('#' + pane.id === targetPaneSelector) {
        pane.classList.add('show', 'active');
      } else {
        pane.classList.remove('show', 'active');
      }
    });

    if (updateUrl && window.location.hash !== matchedHash) {
      history.replaceState(null, '', matchedHash);
    }

    if (targetPaneSelector === '#tab-usage') {
      loadUsageAnalytics();
    }
  }

  /**
   * Carga toda la configuración desde GET /api/settings/llm y GET /api/llm/status
   */
  async function loadAllSettings() {
    try {
      const res = await fetch('/api/settings/llm', { headers: getAuthHeaders() });
      const data = await res.json();
      if (!data.ok) {
        showGlobalFeedback(data.message || 'Error al cargar configuración.', 'danger');
        return;
      }

      state.settings = data.settings;
      state.models = data.models || [];
      state.modelsMap = {};
      state.models.forEach((m) => {
        state.modelsMap[m.model_id] = m;
      });
      state.profiles = data.profiles || [];
      state.budget = data.budget || null;
      state.history = data.history || [];

      renderSidebarStatus();
      renderGeneralForm();
      renderBudgetSection();
      renderTaskProfilesTable();
      renderModelsCatalogTable();
      renderHistoryTable();

      await refreshGlobalLlmStatus();
      await loadUsageAnalytics();
    } catch (err) {
      showGlobalFeedback('Error de red al consultar /api/settings/llm: ' + err.message, 'danger');
    }
  }

  function renderSidebarStatus() {
    const s = state.settings;
    const sidebarBadge = document.getElementById('sidebarLlmStatusBadge');
    if (sidebarBadge && s) {
      if (s.activo && s.has_api_key) {
        sidebarBadge.className = 'badge bg-success';
        sidebarBadge.textContent = 'Activo';
      } else if (!s.activo) {
        sidebarBadge.className = 'badge bg-secondary';
        sidebarBadge.textContent = 'Deshabilitado';
      } else {
        sidebarBadge.className = 'badge bg-warning text-dark';
        sidebarBadge.textContent = 'Sin API Key';
      }
    }
  }

  function renderGeneralForm() {
    const s = state.settings;
    if (!s) return;

    const switchEl = document.getElementById('llmActivoSwitch');
    if (switchEl) switchEl.checked = Boolean(s.activo);

    const savedKeyContainer = document.getElementById('savedKeyContainer');
    const newKeyInputWrapper = document.getElementById('newKeyInputWrapper');
    const maskedDisplay = document.getElementById('maskedApiKeyDisplay');
    const apiKeyInput = document.getElementById('apiKeyInput');
    const btnCancelReplace = document.getElementById('btnCancelReplaceKey');

    state.replacingKey = false;
    state.removeKeyRequested = false;
    if (apiKeyInput) apiKeyInput.value = '';

    if (s.has_api_key && s.api_key_masked) {
      savedKeyContainer?.classList.remove('d-none');
      newKeyInputWrapper?.classList.add('d-none');
      if (maskedDisplay) maskedDisplay.textContent = s.api_key_masked;
      btnCancelReplace?.classList.remove('d-none');
    } else {
      savedKeyContainer?.classList.add('d-none');
      newKeyInputWrapper?.classList.remove('d-none');
      btnCancelReplace?.classList.add('d-none');
    }

    const modelSelect = document.getElementById('defaultModelSelect');
    if (modelSelect) {
      modelSelect.innerHTML = '';
      const availableModels = state.models.filter((m) => m.disponible || m.model_id === s.default_model);
      availableModels.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.model_id;
        opt.textContent = `${m.nombre_visible} (${(m.ventana_contexto / 1000).toFixed(0)}k ctx · $${Number(m.precio_entrada_mtok).toFixed(2)}/$${Number(m.precio_salida_mtok).toFixed(2)} MTok)`;
        if (m.model_id === s.default_model) opt.selected = true;
        modelSelect.appendChild(opt);
      });
    }

    const maxTokensInput = document.getElementById('maxTokensInput');
    const maxTokensSlider = document.getElementById('maxTokensSlider');
    if (maxTokensInput) maxTokensInput.value = String(s.max_tokens);
    if (maxTokensSlider) maxTokensSlider.value = String(s.max_tokens);

    updateSelectedModelSpecsAndMaxTokensBounds();

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val === null || val === undefined ? '' : String(val);
    };

    setVal('temperatureInput', s.temperature);
    setVal('topPInput', s.top_p);
    setVal('timeoutMsInput', s.timeout_ms);
    setVal('maxRetriesInput', s.max_retries);
    setVal('maxInputCharsInput', s.max_input_chars);
    setVal('anthropicVersionInput', s.anthropic_version);
    setVal('apiBaseUrlInput', s.api_base_url);

    setVal('limiteTokensDiarioInput', s.limite_tokens_diario);
    setVal('limiteCostoMensualInput', s.limite_costo_mensual);
    setVal('accionLimiteSelect', s.accion_limite || 'avisar');
  }

  function updateSelectedModelSpecsAndMaxTokensBounds() {
    const modelSelect = document.getElementById('defaultModelSelect');
    const selectedId = modelSelect ? modelSelect.value : state.settings?.default_model;
    const model = state.modelsMap[selectedId] || {
      ventana_contexto: 200000,
      max_output_tokens: 8192,
      precio_entrada_mtok: 3.0,
      precio_salida_mtok: 15.0,
    };

    const ctxEl = document.getElementById('specContextWindow');
    const maxOutEl = document.getElementById('specMaxOutput');
    const pInEl = document.getElementById('specPriceIn');
    const pOutEl = document.getElementById('specPriceOut');

    if (ctxEl) ctxEl.textContent = Number(model.ventana_contexto).toLocaleString();
    if (maxOutEl) maxOutEl.textContent = Number(model.max_output_tokens).toLocaleString();
    if (pInEl) pInEl.textContent = `$${Number(model.precio_entrada_mtok).toFixed(2)}`;
    if (pOutEl) pOutEl.textContent = `$${Number(model.precio_salida_mtok).toFixed(2)}`;

    const limitLabel = document.getElementById('maxTokensLimitLabel');
    const sliderMaxLabel = document.getElementById('maxTokensSliderMax');
    const maxTokensInput = document.getElementById('maxTokensInput');
    const maxTokensSlider = document.getElementById('maxTokensSlider');
    const msgEl = document.getElementById('maxTokensValidationMsg');

    const limit = Number(model.max_output_tokens) || 8192;
    if (limitLabel) limitLabel.textContent = `${limit.toLocaleString()} tokens`;
    if (sliderMaxLabel) sliderMaxLabel.textContent = `Máx: ${limit.toLocaleString()}`;
    if (maxTokensSlider) maxTokensSlider.max = String(limit);
    if (maxTokensInput) maxTokensInput.max = String(limit);

    const currentVal = Number(maxTokensInput?.value || 4096);
    if (msgEl) {
      if (currentVal > limit) {
        msgEl.className = 'text-danger fw-bold';
        msgEl.textContent = `Excede el máximo del modelo (${limit.toLocaleString()} tokens)`;
      } else {
        msgEl.className = 'text-success fw-medium';
        msgEl.textContent = `${currentVal.toLocaleString()} / ${limit.toLocaleString()} tokens`;
      }
    }
  }

  function renderBudgetSection() {
    const b = state.budget;
    if (!b) return;

    const tokLabel = document.getElementById('budgetTokensTodayLabel');
    const tokBar = document.getElementById('budgetTokensProgressBar');
    if (tokLabel) {
      tokLabel.textContent = b.limiteTokensDiario
        ? `${Number(b.tokensHoy).toLocaleString()} / ${Number(b.limiteTokensDiario).toLocaleString()} (${b.porcentajeTokensDiario}%)`
        : `${Number(b.tokensHoy).toLocaleString()} / Sin límite`;
    }
    if (tokBar) {
      const pct = b.porcentajeTokensDiario || 0;
      tokBar.style.width = `${pct}%`;
      tokBar.className = `progress-bar ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-theme'}`;
    }

    const costLabel = document.getElementById('budgetCostMonthLabel');
    const costBar = document.getElementById('budgetCostProgressBar');
    if (costLabel) {
      costLabel.textContent = b.limiteCostoMensual
        ? `$${Number(b.costoMesActual).toFixed(4)} / $${Number(b.limiteCostoMensual).toFixed(2)} USD (${b.porcentajeCostoMensual}%)`
        : `$${Number(b.costoMesActual).toFixed(4)} USD / Sin límite`;
    }
    if (costBar) {
      const pct = b.porcentajeCostoMensual || 0;
      costBar.style.width = `${pct}%`;
      costBar.className = `progress-bar ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-success'}`;
    }
  }

  function renderTaskProfilesTable() {
    const tbody = document.getElementById('taskProfilesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const s = state.settings;
    state.profiles.forEach((p) => {
      const tr = document.createElement('tr');
      tr.dataset.tarea = p.tarea;

      const modelOptions = [
        `<option value="">-- Heredar por defecto (${s?.default_model || ''}) --</option>`,
        ...state.models
          .filter((m) => m.disponible || m.model_id === p.model)
          .map(
            (m) =>
              `<option value="${m.model_id}" ${p.model === m.model_id ? 'selected' : ''}>${m.nombre_visible}</option>`
          ),
      ].join('');

      tr.innerHTML = `
        <td>
          <div class="fw-bold text-dark">${p.nombre_tarea || p.tarea}</div>
          <div class="small text-secondary"><code>${p.tarea}</code></div>
        </td>
        <td>
          <select class="form-select form-select-sm profile-model-select">${modelOptions}</select>
        </td>
        <td>
          <input type="number" class="form-control form-control-sm profile-maxtokens-input"
            placeholder="Hereda (${s?.max_tokens || 4096})"
            value="${p.max_tokens !== null && p.max_tokens !== undefined ? p.max_tokens : ''}" min="64" max="200000">
        </td>
        <td>
          <input type="number" class="form-control form-control-sm profile-temp-input"
            placeholder="Hereda (${s?.temperature ?? 0.2})"
            value="${p.temperature !== null && p.temperature !== undefined ? p.temperature : ''}" min="0" max="1" step="0.05">
        </td>
        <td>
          <textarea class="form-control form-control-sm profile-prompt-input" rows="2">${p.system_prompt || ''}</textarea>
        </td>
        <td class="text-center">
          <div class="form-check form-switch d-inline-block">
            <input class="form-check-input profile-active-switch" type="checkbox" ${p.activo ? 'checked' : ''}>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderModelsCatalogTable() {
    const tbody = document.getElementById('modelsCatalogTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    state.models.forEach((m) => {
      const tr = document.createElement('tr');
      tr.dataset.modelId = m.model_id;
      tr.innerHTML = `
        <td><code>${m.model_id}</code></td>
        <td>
          <input type="text" class="form-control form-control-sm model-name-input" value="${m.nombre_visible}">
        </td>
        <td>
          <input type="number" class="form-control form-control-sm model-ctx-input" value="${m.ventana_contexto}" step="1000">
        </td>
        <td>
          <input type="number" class="form-control form-control-sm model-maxout-input" value="${m.max_output_tokens}" step="1024">
        </td>
        <td>
          <div class="input-group input-group-sm">
            <span class="input-group-text">$</span>
            <input type="number" class="form-control model-price-in-input" value="${Number(m.precio_entrada_mtok).toFixed(2)}" step="0.1" min="0">
          </div>
        </td>
        <td>
          <div class="input-group input-group-sm">
            <span class="input-group-text">$</span>
            <input type="number" class="form-control model-price-out-input" value="${Number(m.precio_salida_mtok).toFixed(2)}" step="0.1" min="0">
          </div>
        </td>
        <td class="text-center">
          <div class="form-check form-switch d-inline-block">
            <input class="form-check-input model-avail-switch" type="checkbox" ${m.disponible ? 'checked' : ''}>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderHistoryTable() {
    const tbody = document.getElementById('historyAuditTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!state.history || state.history.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-3">Sin registros de auditoría aún.</td></tr>`;
      return;
    }

    state.history.forEach((h) => {
      const tr = document.createElement('tr');
      const fechaStr = new Date(h.fecha).toLocaleString();
      const diffStr = JSON.stringify(h.campos_modificados || {});
      tr.innerHTML = `
        <td class="text-nowrap">${fechaStr}</td>
        <td><span class="badge bg-light text-dark border">${h.usuario}</span></td>
        <td><strong>${h.accion}</strong></td>
        <td class="text-center">${h.version_resultante ? 'v' + h.version_resultante : '-'}</td>
        <td><code class="small text-break">${diffStr}</code></td>
      `;
      tbody.appendChild(tr);
    });
  }

  async function refreshGlobalLlmStatus() {
    try {
      const res = await fetch('/api/llm/status');
      const status = await res.json();

      const fallbackBanner = document.getElementById('llmFallbackBanner');
      const fallbackText = document.getElementById('llmFallbackBannerText');

      if (!status.ready) {
        fallbackBanner?.classList.remove('d-none');
        if (fallbackText && status.warning_message) {
          fallbackText.textContent = status.warning_message;
        }
      } else {
        fallbackBanner?.classList.add('d-none');
      }
    } catch {
      // ignore
    }
  }

  async function loadUsageAnalytics() {
    try {
      const taskFilter = document.getElementById('usageFilterTask')?.value || 'all';
      const res = await fetch(`/api/settings/llm/usage?tarea=${encodeURIComponent(taskFilter)}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok) return;

      state.lastUsageData = data;
      renderUsageTables(data);
      renderUsageCharts(data);
    } catch {
      // ignore
    }
  }

  function renderUsageTables(data) {
    const byDayBody = document.getElementById('usageByDayTableBody');
    if (byDayBody) {
      byDayBody.innerHTML =
        (data.by_day || [])
          .map(
            (r) => `<tr>
          <td>${r.dia}</td>
          <td class="text-end">${Number(r.total_tokens || 0).toLocaleString()}</td>
          <td class="text-end fw-bold">$${Number(r.costo_total || 0).toFixed(5)}</td>
        </tr>`
          )
          .join('') || `<tr><td colspan="3" class="text-center text-secondary">Sin datos</td></tr>`;
    }

    const byTaskBody = document.getElementById('usageByTaskTableBody');
    if (byTaskBody) {
      byTaskBody.innerHTML =
        (data.by_task || [])
          .map(
            (r) => `<tr>
          <td><code>${r.tarea}</code></td>
          <td class="text-end">${r.llamadas}</td>
          <td class="text-end">${(Number(r.tokens_entrada || 0) + Number(r.tokens_salida || 0)).toLocaleString()}</td>
          <td class="text-end fw-bold">$${Number(r.costo_total || 0).toFixed(5)}</td>
        </tr>`
          )
          .join('') || `<tr><td colspan="4" class="text-center text-secondary">Sin datos</td></tr>`;
    }

    const byModelBody = document.getElementById('usageByModelTableBody');
    if (byModelBody) {
      byModelBody.innerHTML =
        (data.by_model || [])
          .map(
            (r) => `<tr>
          <td><code>${r.modelo}</code></td>
          <td class="text-end">${r.llamadas}</td>
          <td class="text-end">${(Number(r.tokens_entrada || 0) + Number(r.tokens_salida || 0)).toLocaleString()}</td>
          <td class="text-end fw-bold">$${Number(r.costo_total || 0).toFixed(5)}</td>
        </tr>`
          )
          .join('') || `<tr><td colspan="4" class="text-center text-secondary">Sin datos</td></tr>`;
    }

    const logsBody = document.getElementById('recentUsageLogsTableBody');
    if (logsBody) {
      logsBody.innerHTML =
        (data.recent_logs || [])
          .map(
            (r) => `<tr>
          <td class="text-nowrap">${new Date(r.fecha).toLocaleTimeString()}</td>
          <td><code>${r.tarea}</code></td>
          <td><span class="badge bg-light text-dark border">${r.modelo}</span></td>
          <td class="text-end">${r.tokens_entrada} / ${r.tokens_salida} / ${Number(r.tokens_cache_creacion || 0) + Number(r.tokens_cache_lectura || 0)}</td>
          <td class="text-end">$${Number(r.costo_estimado || 0).toFixed(6)}</td>
          <td class="text-end">${r.latencia_ms} ms</td>
          <td class="text-center">
            ${
              r.exito
                ? '<span class="badge bg-success">Éxito</span>'
                : `<span class="badge bg-danger" title="${r.mensaje_error || ''}">${r.codigo_error || 'Error'}</span>`
            }
          </td>
          <td><small class="text-secondary">${r.tender_id || '-'} ${r.document_id ? '/ ' + r.document_id : ''}</small></td>
        </tr>`
          )
          .join('') || `<tr><td colspan="8" class="text-center text-secondary py-3">Aún no hay llamadas registradas.</td></tr>`;
    }
  }

  function renderUsageCharts(data) {
    if (typeof window.Chart === 'undefined') return;

    const dayCtx = document.getElementById('usageByDayChart')?.getContext('2d');
    if (dayCtx) {
      if (state.charts.byDay) state.charts.byDay.destroy();
      const labels = (data.by_day || []).map((d) => d.dia);
      const values = (data.by_day || []).map((d) => Number(d.total_tokens || 0));

      state.charts.byDay = new window.Chart(dayCtx, {
        type: 'bar',
        data: {
          labels: labels.length ? labels : ['Hoy'],
          datasets: [
            {
              label: 'Tokens Totales por Día',
              data: values.length ? values : [0],
              backgroundColor: 'rgba(13, 110, 253, 0.65)',
              borderColor: 'rgba(13, 110, 253, 1)',
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { beginAtZero: true } },
        },
      });
    }

    const taskCtx = document.getElementById('costByTaskChart')?.getContext('2d');
    if (taskCtx) {
      if (state.charts.byTask) state.charts.byTask.destroy();
      const labels = (data.by_task || []).map((t) => t.tarea);
      const values = (data.by_task || []).map((t) => Number(t.costo_total || 0));

      state.charts.byTask = new window.Chart(taskCtx, {
        type: 'doughnut',
        data: {
          labels: labels.length ? labels : ['Sin consumo'],
          datasets: [
            {
              data: values.length ? values : [1],
              backgroundColor: ['#0d6efd', '#198754', '#ffc107', '#6f42c1', '#20c997'],
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
        },
      });
    }
  }

  function bindEvents() {
    // Navegación directa de Pestañas (soporta clic en ícono o texto y cambia el hash del URL)
    document.querySelectorAll('#llmAdminTabs .nav-link').forEach((tabLink) => {
      tabLink.addEventListener('click', (e) => {
        e.preventDefault();
        const hash = tabLink.getAttribute('href') || '#conexion';
        activateTab(hash, true);
      });
    });

    window.addEventListener('hashchange', () => {
      if (window.location.hash && TAB_HASH_MAP[window.location.hash]) {
        activateTab(window.location.hash, false);
      }
    });

    // Activar pestaña inicial si el URL trae hash (#perfiles, #consumo, #historial)
    if (window.location.hash && TAB_HASH_MAP[window.location.hash]) {
      activateTab(window.location.hash, false);
    }

    // Cambio en el selector de modelo por defecto -> actualiza specs y máximo del slider max_tokens
    document.getElementById('defaultModelSelect')?.addEventListener('change', () => {
      updateSelectedModelSpecsAndMaxTokensBounds();
    });

    // Sincronización bidireccional entre campo numérico max_tokens y slider
    const maxInput = document.getElementById('maxTokensInput');
    const maxSlider = document.getElementById('maxTokensSlider');

    maxSlider?.addEventListener('input', () => {
      if (maxInput) maxInput.value = maxSlider.value;
      updateSelectedModelSpecsAndMaxTokensBounds();
    });

    maxInput?.addEventListener('input', () => {
      if (maxSlider) maxSlider.value = maxInput.value;
      updateSelectedModelSpecsAndMaxTokensBounds();
    });

    // Botones de Clave de API: Reemplazar, Eliminar, Mostrar/Ocultar
    document.getElementById('btnReplaceKey')?.addEventListener('click', () => {
      state.replacingKey = true;
      state.removeKeyRequested = false;
      document.getElementById('savedKeyContainer')?.classList.add('d-none');
      document.getElementById('newKeyInputWrapper')?.classList.remove('d-none');
      document.getElementById('apiKeyInput')?.focus();
    });

    document.getElementById('btnCancelReplaceKey')?.addEventListener('click', () => {
      state.replacingKey = false;
      const input = document.getElementById('apiKeyInput');
      if (input) input.value = '';
      if (state.settings?.has_api_key) {
        document.getElementById('savedKeyContainer')?.classList.remove('d-none');
        document.getElementById('newKeyInputWrapper')?.classList.add('d-none');
      }
    });

    document.getElementById('btnDeleteKey')?.addEventListener('click', async () => {
      state.removeKeyRequested = true;
      state.replacingKey = false;
      await saveGeneralSettings(new Event('submit'));
    });

    document.getElementById('btnToggleKeyVisibility')?.addEventListener('click', () => {
      const input = document.getElementById('apiKeyInput');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    // Guardar formulario general (PUT /api/settings/llm)
    document.getElementById('llmSettingsForm')?.addEventListener('submit', saveGeneralSettings);

    // Interruptor general guarda directamente al conmutar
    document.getElementById('llmActivoSwitch')?.addEventListener('change', () => {
      saveGeneralSettings(new Event('submit'));
    });

    // Botón "Probar conexión" (POST /api/settings/llm/test)
    document.getElementById('btnTestConnection')?.addEventListener('click', handleTestConnection);

    // Botones "Sincronizar modelos" (POST /api/settings/llm/models/sync)
    document.getElementById('btnSyncModels')?.addEventListener('click', handleSyncModels);
    document.getElementById('btnSyncModelsCatalog')?.addEventListener('click', handleSyncModels);

    // Guardar perfiles por tarea (PUT /api/settings/llm/profiles)
    document.getElementById('btnSaveProfiles')?.addEventListener('click', handleSaveProfiles);

    // Guardar precios de catálogo de modelos (PUT /api/settings/llm/models)
    document.getElementById('btnSaveModelsPricing')?.addEventListener('click', handleSaveModelsCatalog);

    // Filtros y exportación CSV del panel de consumo
    document.getElementById('usageFilterTask')?.addEventListener('change', loadUsageAnalytics);
    document.getElementById('btnRefreshUsage')?.addEventListener('click', loadUsageAnalytics);
    document.getElementById('btnExportCsv')?.addEventListener('click', () => {
      const taskFilter = document.getElementById('usageFilterTask')?.value || 'all';
      window.location.href = `/api/settings/llm/usage?format=csv&tarea=${encodeURIComponent(taskFilter)}`;
    });
  }

  function collectFormPayload() {
    const rawKey = document.getElementById('apiKeyInput')?.value?.trim() || '';
    return {
      activo: Boolean(document.getElementById('llmActivoSwitch')?.checked),
      api_key: rawKey.length > 0 ? rawKey : undefined,
      remove_api_key: Boolean(state.removeKeyRequested),
      default_model: document.getElementById('defaultModelSelect')?.value || '',
      max_tokens: Number(document.getElementById('maxTokensInput')?.value || 4096),
      temperature: document.getElementById('temperatureInput')?.value ?? null,
      top_p: document.getElementById('topPInput')?.value ?? null,
      timeout_ms: Number(document.getElementById('timeoutMsInput')?.value || 60000),
      max_retries: Number(document.getElementById('maxRetriesInput')?.value ?? 3),
      max_input_chars: Number(document.getElementById('maxInputCharsInput')?.value || 120000),
      anthropic_version: document.getElementById('anthropicVersionInput')?.value || '2023-06-01',
      api_base_url: document.getElementById('apiBaseUrlInput')?.value || 'https://api.anthropic.com',
      limite_tokens_diario: document.getElementById('limiteTokensDiarioInput')?.value ?? null,
      limite_costo_mensual: document.getElementById('limiteCostoMensualInput')?.value ?? null,
      accion_limite: document.getElementById('accionLimiteSelect')?.value || 'avisar',
    };
  }

  async function saveGeneralSettings(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const payload = collectFormPayload();

    try {
      const res = await fetch('/api/settings/llm', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showGlobalFeedback(data.message || 'Error de validación al guardar configuración.', 'danger');
        return;
      }

      showGlobalFeedback('Configuración guardada correctamente.', 'success');
      await loadAllSettings();
    } catch (err) {
      showGlobalFeedback('Error al guardar configuración: ' + err.message, 'danger');
    }
  }

  async function handleTestConnection() {
    const btn = document.getElementById('btnTestConnection');
    const box = document.getElementById('testConnectionResultBox');
    const title = document.getElementById('testResultTitle');
    const badge = document.getElementById('testResultBadge');
    const msg = document.getElementById('testResultMessage');
    const metrics = document.getElementById('testResultMetrics');

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Probando conexión...`;
    }

    const formPayload = collectFormPayload();
    const testPayload = {
      api_key: formPayload.api_key,
      api_base_url: formPayload.api_base_url,
      anthropic_version: formPayload.anthropic_version,
      model: formPayload.default_model,
      max_tokens: 32,
      temperature: formPayload.temperature,
      timeout_ms: formPayload.timeout_ms,
    };

    try {
      const res = await fetch('/api/settings/llm/test', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(testPayload),
      });
      const data = await res.json();

      box?.classList.remove('d-none', 'bg-light-green', 'bg-light-red', 'border-success', 'border-danger');

      if (data.ok) {
        box?.classList.add('border-success', 'bg-light');
        if (title) title.textContent = 'Conexión Verificada';
        if (badge) {
          badge.className = 'badge bg-success';
          badge.textContent = 'OK';
        }
        if (msg) msg.textContent = data.message;
        metrics?.classList.remove('d-none');
        document.getElementById('testMetricModel').textContent = data.model;
        document.getElementById('testMetricLatency').textContent = `${data.latency_ms} ms`;
        document.getElementById('testMetricTokens').textContent = `${data.usage?.total_tokens || 0} tok`;
      } else {
        box?.classList.add('border-danger', 'bg-light');
        if (title) title.textContent = 'Error en la Prueba de Conexión';
        if (badge) {
          badge.className = 'badge bg-danger';
          badge.textContent = data.error_code || 'ERROR';
        }
        if (msg) msg.textContent = data.error_message || 'Error desconocido al conectar con Anthropic.';
        metrics?.classList.add('d-none');
      }

      await loadUsageAnalytics();
    } catch (err) {
      box?.classList.remove('d-none');
      if (msg) msg.textContent = 'Error de red al probar conexión: ' + err.message;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-lightning-charge-fill me-1"></i> Probar conexión`;
      }
    }
  }

  async function handleSyncModels() {
    const rawKey = document.getElementById('apiKeyInput')?.value?.trim() || null;
    try {
      const res = await fetch('/api/settings/llm/models/sync', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ api_key: rawKey }),
      });
      const data = await res.json();
      if (data.ok) {
        showGlobalFeedback(data.message, 'success');
        await loadAllSettings();
      } else {
        showGlobalFeedback(data.message || 'No se pudo sincronizar el catálogo.', 'warning');
      }
    } catch (err) {
      showGlobalFeedback('Error al sincronizar modelos: ' + err.message, 'danger');
    }
  }

  async function handleSaveProfiles() {
    const rows = document.querySelectorAll('#taskProfilesTableBody tr');
    const profiles = [];
    rows.forEach((tr) => {
      const tarea = tr.dataset.tarea;
      const model = tr.querySelector('.profile-model-select')?.value || null;
      const maxTokensVal = tr.querySelector('.profile-maxtokens-input')?.value;
      const tempVal = tr.querySelector('.profile-temp-input')?.value;
      const systemPrompt = tr.querySelector('.profile-prompt-input')?.value || '';
      const activo = Boolean(tr.querySelector('.profile-active-switch')?.checked);

      profiles.push({
        tarea,
        model: model && model.trim() !== '' ? model : null,
        max_tokens: maxTokensVal && maxTokensVal.trim() !== '' ? Number(maxTokensVal) : null,
        temperature: tempVal && tempVal.trim() !== '' ? Number(tempVal) : null,
        system_prompt: systemPrompt,
        activo,
      });
    });

    try {
      const res = await fetch('/api/settings/llm/profiles', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ profiles }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showGlobalFeedback(data.message || 'Error al guardar perfiles.', 'danger');
        return;
      }
      showGlobalFeedback(data.message, 'success');
      await loadAllSettings();
    } catch (err) {
      showGlobalFeedback('Error al guardar perfiles: ' + err.message, 'danger');
    }
  }

  async function handleSaveModelsCatalog() {
    const rows = document.querySelectorAll('#modelsCatalogTableBody tr');
    const models = [];
    rows.forEach((tr) => {
      models.push({
        model_id: tr.dataset.modelId,
        nombre_visible: tr.querySelector('.model-name-input')?.value || tr.dataset.modelId,
        ventana_contexto: Number(tr.querySelector('.model-ctx-input')?.value || 200000),
        max_output_tokens: Number(tr.querySelector('.model-maxout-input')?.value || 8192),
        precio_entrada_mtok: Number(tr.querySelector('.model-price-in-input')?.value || 0),
        precio_salida_mtok: Number(tr.querySelector('.model-price-out-input')?.value || 0),
        disponible: Boolean(tr.querySelector('.model-avail-switch')?.checked),
      });
    });

    try {
      const res = await fetch('/api/settings/llm/models', {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ models }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showGlobalFeedback(data.message || 'Error al actualizar catálogo de modelos.', 'danger');
        return;
      }
      showGlobalFeedback(data.message, 'success');
      await loadAllSettings();
    } catch (err) {
      showGlobalFeedback('Error al guardar catálogo: ' + err.message, 'danger');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadAllSettings();
  });
})();
