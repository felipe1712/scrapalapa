/**
 * Scrapper — Licitaciones & Pipeline
 */
(function () {
  'use strict';

  const state = {
    currentTender: null,
    currentDocuments: [],
    activeViewerDocId: null,
    tendersList: [],
  };

  const TAB_MAP = {
    '#sintesis': '#pane-sintesis',
    '#historial': '#pane-historial',
  };

  function activateTab(hash, updateUrl = true) {
    const targetSelector = TAB_MAP[hash] || '#pane-sintesis';
    document.querySelectorAll('#tenderTabs .nav-link').forEach((link) => {
      if (link.getAttribute('href') === hash) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });

    document.querySelectorAll('#tenderTabsContent .tab-pane').forEach((pane) => {
      if ('#' + pane.id === targetSelector) {
        pane.classList.add('show', 'active');
      } else {
        pane.classList.remove('show', 'active');
      }
    });

    if (updateUrl && window.location.hash !== hash) {
      history.replaceState(null, '', hash);
    }
  }

  function showAlert(message, type = 'danger') {
    const el = document.getElementById('ingestFeedbackAlert');
    if (!el) return;
    el.className = `alert alert-${type} border-0 shadow-sm mb-3`;
    el.innerHTML = `<div class="d-flex align-items-center justify-content-between">
      <span>${message}</span>
      <button type="button" class="btn-close" onclick="this.parentElement.parentElement.classList.add('d-none')"></button>
    </div>`;
    el.classList.remove('d-none');
  }

  async function loadPipelineStatus() {
    try {
      const res = await fetch('/api/llm/status');
      const status = await res.json();

      const sidebarBadge = document.getElementById('sidebarLlmStatusBadge');
      const sidebarModel = document.getElementById('sidebarActiveModel');
      const warnBanner = document.getElementById('pipelineWarningBanner');
      const warnText = document.getElementById('pipelineWarningText');

      if (sidebarModel) sidebarModel.textContent = status.default_model || '-';

      if (status.ready) {
        if (sidebarBadge) {
          sidebarBadge.className = 'badge bg-success';
          sidebarBadge.textContent = 'Activo';
        }
        warnBanner?.classList.add('d-none');
      } else {
        if (sidebarBadge) {
          sidebarBadge.className = 'badge bg-warning text-dark';
          sidebarBadge.textContent = !status.llm_enabled ? 'Deshabilitado' : 'Sin API Key';
        }
        warnBanner?.classList.remove('d-none');
        if (warnText) {
          warnText.textContent = status.warning_message || '';
        }
      }
    } catch {
      // ignore
    }
  }

  async function loadTendersHistory() {
    try {
      const res = await fetch('/api/tenders');
      const data = await res.json();
      if (!data.ok) return;

      state.tendersList = data.tenders || [];
      const countBadge = document.getElementById('tendersCountBadge');
      if (countBadge) countBadge.textContent = String(state.tendersList.length);

      const tbody = document.getElementById('tendersHistoryTableBody');
      if (!tbody) return;

      if (state.tendersList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-4">Aún no se ha extraído ninguna licitación. Ingresa una URL arriba.</td></tr>`;
        return;
      }

      tbody.innerHTML = state.tendersList
        .map((t) => {
          const presupuestoStr = t.presupuesto_estimado
            ? `$${Number(t.presupuesto_estimado).toLocaleString()} ${t.moneda || 'MXN'}`
            : '-';
          return `<tr>
            <td><strong>#${t.id}</strong></td>
            <td class="text-nowrap">${new Date(t.created_at).toLocaleString()}</td>
            <td>
              <div class="fw-bold text-dark text-truncate" style="max-width: 280px;">${t.titulo || t.source_url}</div>
              <a href="${t.source_url}" target="_blank" class="small text-secondary text-truncate d-block" style="max-width: 280px;">${t.source_url}</a>
            </td>
            <td>${t.entidad || '-'}</td>
            <td class="text-end fw-bold">${presupuestoStr}</td>
            <td class="text-center"><span class="badge bg-light text-dark border">${t.total_documentos || 0}</span></td>
            <td><span class="badge bg-light text-dark border">${t.modelo_utilizado || '-'}</span></td>
            <td class="text-end text-nowrap">
              <button type="button" class="btn btn-sm btn-outline-primary btn-view-tender" data-id="${t.id}">
                <i class="bi bi-eye me-1"></i> Ver
              </button>
              <button type="button" class="btn btn-sm btn-outline-danger btn-delete-tender ms-1" data-id="${t.id}">
                <i class="bi bi-trash"></i>
              </button>
            </td>
          </tr>`;
        })
        .join('');

      tbody.querySelectorAll('.btn-view-tender').forEach((btn) => {
        btn.addEventListener('click', () => loadSingleTender(Number(btn.getAttribute('data-id')), true));
      });

      tbody.querySelectorAll('.btn-delete-tender').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.getAttribute('data-id'));
          await fetch(`/api/tenders/${id}`, { method: 'DELETE' });
          await loadTendersHistory();
        });
      });

      if (!state.currentTender && state.tendersList.length > 0) {
        await loadSingleTender(state.tendersList[0].id, false);
      }
    } catch {
      // ignore
    }
  }

  async function loadSingleTender(id, switchToSynthesis = true) {
    try {
      const res = await fetch(`/api/tenders/${id}`);
      const data = await res.json();
      if (!data.ok) return;

      state.currentTender = data.tender;
      state.currentDocuments = data.documents || [];
      state.activeViewerDocId = state.currentDocuments[0]?.id || null;
      renderActiveTender();
      if (switchToSynthesis) {
        activateTab('#sintesis');
      }
    } catch {
      // ignore
    }
  }

  function renderInlinePdfViewer(docId) {
    const viewerCard = document.getElementById('inlinePdfViewerCard');
    const viewerFrame = document.getElementById('inlinePdfViewerFrame');
    const viewerTitle = document.getElementById('inlinePdfViewerTitle');
    const viewerMeta = document.getElementById('inlinePdfViewerMeta');
    const openNewTabBtn = document.getElementById('inlinePdfOpenNewTab');
    const downloadBtn = document.getElementById('inlinePdfDownloadBtn');

    if (!viewerCard || !viewerFrame) return;

    const doc = state.currentDocuments.find((d) => d.id === Number(docId)) || state.currentDocuments[0];
    if (!doc) {
      viewerCard.classList.add('d-none');
      viewerFrame.src = 'about:blank';
      return;
    }

    state.activeViewerDocId = doc.id;
    viewerCard.classList.remove('d-none');

    const inlineUrl = `/api/tenders/documents/${doc.id}/download`;
    const downloadUrl = `/api/tenders/documents/${doc.id}/download?download=1`;

    if (viewerTitle) {
      viewerTitle.textContent = doc.file_name || 'Documento de Licitación';
    }
    if (viewerMeta) {
      const kb = (Number(doc.file_size_bytes || 0) / 1024).toFixed(1);
      viewerMeta.textContent = `${(doc.file_type || 'pdf').toUpperCase()} · ${doc.paginas_procesadas || 1} pág(s) · ${kb} KB`;
    }
    if (openNewTabBtn) openNewTabBtn.href = inlineUrl;
    if (downloadBtn) downloadBtn.href = downloadUrl;

    if (viewerFrame.getAttribute('data-loaded-url') !== inlineUrl) {
      viewerFrame.setAttribute('data-loaded-url', inlineUrl);
      viewerFrame.src = inlineUrl;
    }

    // Actualizar estado activo de los botones de selección de documento
    document.querySelectorAll('.btn-select-viewer-doc').forEach((btn) => {
      const btnId = Number(btn.getAttribute('data-doc-id'));
      if (btnId === doc.id) {
        btn.classList.remove('btn-outline-primary');
        btn.classList.add('btn-theme');
      } else {
        btn.classList.remove('btn-theme');
        btn.classList.add('btn-outline-primary');
      }
    });
  }

  function renderActiveTender() {
    const t = state.currentTender;
    if (!t) return;

    document.getElementById('emptySynthesisState')?.classList.add('d-none');
    document.getElementById('activeTenderContainer')?.classList.remove('d-none');

    // Renderizar Hits de Palabras Clave y listado de documentos encontrados
    const hitsCard = document.getElementById('keywordHitsCard');
    const kwSummary = document.getElementById('keywordsSearchedSummary');
    const hitsListEl = document.getElementById('keywordHitsList');
    const quickDocsEl = document.getElementById('portalDocsQuickLinks');
    const hits = Array.isArray(t.hits_encontrados) ? t.hits_encontrados : [];

    if (hitsCard) {
      if (t.keywords_buscadas || hits.length > 0 || state.currentDocuments.length > 0) {
        hitsCard.classList.remove('d-none');
        if (kwSummary) {
          kwSummary.innerHTML = t.keywords_buscadas
            ? `Palabras buscadas: <strong>${t.keywords_buscadas}</strong> · <strong>${hits.length}</strong> coincidencia(s) ("hits") · <strong>${state.currentDocuments.length}</strong> documento(s) encontrado(s)`
            : `<strong>${state.currentDocuments.length}</strong> documento(s) encontrado(s)`;
        }
        if (quickDocsEl) {
          quickDocsEl.innerHTML = state.currentDocuments
            .map((d, idx) => {
              const isSelected = state.activeViewerDocId ? d.id === state.activeViewerDocId : idx === 0;
              return `<button type="button" class="btn btn-sm ${
                isSelected ? 'btn-theme' : 'btn-outline-primary'
              } btn-select-viewer-doc" data-doc-id="${d.id}">
                <i class="bi bi-file-earmark-pdf me-1"></i> ${d.file_name}
              </button>`;
            })
            .join('');

          quickDocsEl.querySelectorAll('.btn-select-viewer-doc').forEach((btn) => {
            btn.addEventListener('click', () => {
              renderInlinePdfViewer(Number(btn.getAttribute('data-doc-id')));
            });
          });
        }
        if (hitsListEl) {
          if (hits.length > 0) {
            hitsListEl.innerHTML = hits
              .slice(0, 8)
              .map((h) => {
                const badges = (h.matchedKeywords || [])
                  .map((kw) => `<span class="badge bg-success me-1">Hit: ${kw}</span>`)
                  .join('');
                return `<div class="list-group-item px-0 py-2">
                  <div class="mb-1">${badges}</div>
                  <div class="text-dark">${h.contextSnippet || ''}</div>
                </div>`;
              })
              .join('');
          } else if (t.keywords_buscadas) {
            hitsListEl.innerHTML = `<div class="list-group-item px-0 py-2 text-warning">
              <i class="bi bi-exclamation-circle me-1"></i> No se encontraron coincidencias exactas para "${t.keywords_buscadas}" en esta URL.
            </div>`;
          } else {
            hitsListEl.innerHTML = '';
          }
        }
      } else {
        hitsCard.classList.add('d-none');
      }
    }

    // Mostrar Visor PDF In-Situ abajo del listado de documentos encontrados
    if (state.currentDocuments.length > 0) {
      renderInlinePdfViewer(state.activeViewerDocId || state.currentDocuments[0].id);
    } else {
      document.getElementById('inlinePdfViewerCard')?.classList.add('d-none');
    }

    document.getElementById('activeTenderTitle').textContent = t.titulo || 'Licitación';
    const srcLink = document.getElementById('activeTenderSourceLink');
    if (srcLink) {
      srcLink.href = t.source_url;
      srcLink.textContent = t.source_url;
    }

    document.getElementById('fieldEntidad').textContent = t.entidad || 'No especificada';
    document.getElementById('fieldExpediente').textContent = t.numero_expediente
      ? `Expediente: ${t.numero_expediente}`
      : '';

    document.getElementById('fieldPresupuesto').textContent = t.presupuesto_estimado
      ? `$${Number(t.presupuesto_estimado).toLocaleString()}`
      : 'Por definir';
    document.getElementById('fieldMoneda').textContent = t.moneda || 'MXN';

    document.getElementById('fieldFechaLimite').textContent = t.fecha_limite || 'No detectada';
    const riesgoEl = document.getElementById('fieldNivelRiesgo');
    if (riesgoEl) {
      riesgoEl.innerHTML = t.nivel_riesgo
        ? `Riesgo: <span class="badge ${
            t.nivel_riesgo === 'alto'
              ? 'bg-danger'
              : t.nivel_riesgo === 'medio'
                ? 'bg-warning text-dark'
                : 'bg-success'
          }">${t.nivel_riesgo.toUpperCase()}</span>`
        : '';
    }

    document.getElementById('fieldModeloUsado').textContent = t.modelo_utilizado || 'Completado';
    document.getElementById('fieldMetricas').textContent = `${(
      Number(t.latencia_total_ms || 0) / 1000
    ).toFixed(1)}s`;

    const synthesisBox = document.getElementById('claudeSynthesisContent');
    if (synthesisBox) {
      synthesisBox.textContent =
        t.sintesis_claude ||
        'Usa el botón "Regenerar Síntesis" para generar el resumen ejecutivo de esta licitación.';
    }

    const reqList = document.getElementById('requisitosList');
    if (reqList) {
      const reqs = t.campos_extraidos_json?.requisitos_clave || [];
      reqList.innerHTML =
        reqs.length > 0
          ? reqs
              .map(
                (r) =>
                  `<li class="list-group-item px-0"><i class="bi bi-check2-circle text-success me-2"></i>${r}</li>`
              )
              .join('')
          : `<li class="list-group-item px-0 text-secondary">Sin requisitos estructurados listados.</li>`;
    }

    const localRulesPre = document.getElementById('localRulesPre');
    if (localRulesPre) {
      localRulesPre.textContent = JSON.stringify(t.extraccion_reglas_locales || {}, null, 2);
    }
  }

  async function handleIngestSubmit(e) {
    e.preventDefault();
    const urlInput = document.getElementById('tenderUrlInput');
    const url = urlInput?.value?.trim() || '';
    if (!url) {
      showAlert('Ingresa una URL válida para extraer la licitación.', 'warning');
      return;
    }

    const keywords = document.getElementById('tenderKeywordsInput')?.value?.trim() || '';
    const processAttachments = Boolean(document.getElementById('processAttachmentsSwitch')?.checked);
    const requiresAuth = Boolean(document.getElementById('requiresAuthSwitch')?.checked);
    const authUsername = document.getElementById('authUsernameInput')?.value?.trim() || '';
    const authPassword = document.getElementById('authPasswordInput')?.value || '';
    const authLoginUrl = document.getElementById('authLoginUrlInput')?.value?.trim() || '';
    const btn = document.getElementById('btnIngestUrl');

    if (requiresAuth && (!authUsername || !authPassword)) {
      showAlert('Ingresa el usuario y la contraseña para autenticar el acceso a la URL.', 'warning');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span> Buscando y extrayendo...`;
    }

    document.getElementById('ingestFeedbackAlert')?.classList.add('d-none');

    try {
      const payload = {
        url,
        keywords,
        ocr_mode: 'auto',
        process_attachments: processAttachments,
      };
      if (requiresAuth) {
        payload.auth_username = authUsername;
        payload.auth_password = authPassword;
        if (authLoginUrl) payload.auth_login_url = authLoginUrl;
      }

      const res = await fetch('/api/tenders/ingest-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        showAlert(data.message || 'No se pudo procesar la URL indicada.', 'danger');
        return;
      }

      state.currentTender = data.tender;
      state.currentDocuments = data.documents || [];
      state.activeViewerDocId = state.currentDocuments[0]?.id || null;
      renderActiveTender();
      activateTab('#sintesis');
      await loadTendersHistory();

      showAlert('Licitación extraída y documentos cargados con éxito.', 'success');
    } catch (err) {
      showAlert('Error de red al procesar la URL: ' + err.message, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-cloud-arrow-down-fill me-2"></i> Buscar y Extraer`;
      }
    }
  }

  async function handleReanalyze(tarea) {
    if (!state.currentTender) return;
    const box = document.getElementById('claudeSynthesisContent');
    if (box) box.textContent = `Analizando licitación...`;

    try {
      const res = await fetch(`/api/tenders/${state.currentTender.id}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tarea }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showAlert(data.message || 'Error al analizar la licitación.', 'danger');
        return;
      }
      await loadSingleTender(state.currentTender.id, true);
      await loadTendersHistory();
    } catch (err) {
      showAlert('Error al ejecutar análisis: ' + err.message, 'danger');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#tenderTabs .nav-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        activateTab(link.getAttribute('href') || '#sintesis');
      });
    });

    if (window.location.hash && TAB_MAP[window.location.hash]) {
      activateTab(window.location.hash, false);
    }

    document.getElementById('ingestUrlForm')?.addEventListener('submit', handleIngestSubmit);
    document.getElementById('btnRefreshTenders')?.addEventListener('click', loadTendersHistory);

    const authSwitch = document.getElementById('requiresAuthSwitch');
    const authBox = document.getElementById('authCredentialsBox');
    authSwitch?.addEventListener('change', () => {
      if (authSwitch.checked) {
        authBox?.classList.remove('d-none');
      } else {
        authBox?.classList.add('d-none');
      }
    });

    document.querySelectorAll('.reanalyze-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tarea = btn.getAttribute('data-task') || 'resumen_licitacion';
        handleReanalyze(tarea);
      });
    });

    loadPipelineStatus();
    loadTendersHistory();
  });
})();
