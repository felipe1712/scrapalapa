/**
 * Scrapper — Licitaciones & Pipeline (Vista Maestro-Detalle Jerárquica)
 */
(function () {
  'use strict';

  const state = {
    activeProcedureId: null,
    activeDocId: null,
    treeData: [],
    cachedProcedures: new Map(),
    isIngesting: false,
    activeTimelineView: 'cards', // 'cards' | 'table'
  };

  // Helper: Escape HTML
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Helper: Normalize diacritics for searching
  function normalizeText(text) {
    if (!text) return '';
    return text.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // Helper: Format Date
  function formatDate(val) {
    if (!val) return 'Por definir';
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return String(val);
      return d.toLocaleDateString('es-MX', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return String(val);
    }
  }

  // Helper: Render simple markdown to HTML (headings, bold, lists, breaks)
  function renderMarkdown(md) {
    if (!md) return '<p class="text-secondary mb-0">Sin síntesis disponible.</p>';
    let html = escapeHtml(md);

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h6 class="fw-bold text-dark mt-3 mb-2">$1</h6>');
    html = html.replace(/^## (.*$)/gim, '<h5 class="fw-bold text-primary mt-3 mb-2">$1</h5>');
    html = html.replace(/^# (.*$)/gim, '<h4 class="fw-bold text-dark mt-2 mb-2">$1</h4>');

    // Bold & italic
    html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

    // Bullet points
    html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<li class="mb-1">$1</li>');
    html = html.replace(/(<li class="mb-1">.*<\/li>)/gim, '<ul class="mb-2 ps-3">$1</ul>');
    html = html.replace(/<\/ul>\s*<ul class="mb-2 ps-3">/gim, '');

    // Line breaks
    html = html.replace(/\n\n+/g, '<br><br>');

    return html;
  }

  // Global Alert Banner
  function showAlert(message, type = 'danger') {
    const el = document.getElementById('ingestFeedbackAlert');
    if (!el) return;
    el.className = `alert alert-${type} border-0 shadow-sm mb-3`;
    el.innerHTML = `<div class="d-flex align-items-center justify-content-between">
      <span>${message}</span>
      <button type="button" class="btn-close" onclick="this.parentElement.parentElement.classList.add('d-none')"></button>
    </div>`;
    el.classList.remove('d-none');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Load LLM status
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

  // Load Hierarchical Tree of Tenders and Procedures
  async function loadTendersTree(preserveSelection = true) {
    const loadingEl = document.getElementById('treeLoadingState');
    const emptyEl = document.getElementById('treeEmptyState');
    const listEl = document.getElementById('tendersTreeList');
    const totalBadge = document.getElementById('treeTotalProceduresBadge');

    if (!listEl) return;

    try {
      loadingEl?.classList.remove('d-none');
      emptyEl?.classList.add('d-none');

      const res = await fetch('/api/tenders/tree');
      const data = await res.json();

      if (!data.ok || !Array.isArray(data.tree)) {
        throw new Error(data.error || 'Error al obtener árbol de licitaciones');
      }

      state.treeData = data.tree;

      // Count total procedures
      let totalProcedures = 0;
      state.treeData.forEach((parent) => {
        totalProcedures += (parent.procedures || []).length;
      });
      if (totalBadge) totalBadge.textContent = String(totalProcedures);

      renderTree(document.getElementById('treeSearchInput')?.value || '');

      // Selection logic
      if (totalProcedures === 0) {
        emptyEl?.classList.remove('d-none');
        document.getElementById('procedureDetailWrapper')?.classList.add('d-none');
        document.getElementById('emptyProcedureState')?.classList.remove('d-none');
        return;
      }

      // Check if hash points to a procedure (#proc-123)
      let targetProcId = null;
      const hashMatch = window.location.hash.match(/#proc-(\d+)/);
      if (hashMatch) {
        targetProcId = parseInt(hashMatch[1], 10);
      } else if (preserveSelection && state.activeProcedureId) {
        targetProcId = state.activeProcedureId;
      }

      let found = false;
      if (targetProcId) {
        for (const parent of state.treeData) {
          if (parent.procedures?.some((p) => p.id === targetProcId)) {
            found = true;
            selectProcedure(targetProcId);
            break;
          }
        }
      }

      if (!found && state.treeData.length > 0) {
        const firstWithProc = state.treeData.find((p) => p.procedures && p.procedures.length > 0);
        if (firstWithProc && firstWithProc.procedures.length > 0) {
          selectProcedure(firstWithProc.procedures[0].id);
        }
      }
    } catch (err) {
      console.error('Error cargando árbol:', err);
      showAlert(`Error al cargar árbol de licitaciones: ${err.message}`, 'danger');
    } finally {
      loadingEl?.classList.add('d-none');
    }
  }

  // Render Tree with optional search filter
  function renderTree(filterQuery = '') {
    const listEl = document.getElementById('tendersTreeList');
    const emptyEl = document.getElementById('treeEmptyState');
    if (!listEl) return;

    const normQuery = normalizeText(filterQuery.trim());
    listEl.innerHTML = '';

    let visibleParents = 0;

    state.treeData.forEach((doc, docIdx) => {
      const procedures = doc.procedures || [];
      const parentMatches =
        normQuery === '' ||
        normalizeText(doc.titulo).includes(normQuery) ||
        normalizeText(doc.entidad).includes(normQuery);

      const matchingProcedures = procedures.filter((p) => {
        if (normQuery === '') return true;
        return (
          parentMatches ||
          normalizeText(p.numero_procedimiento).includes(normQuery) ||
          normalizeText(p.titulo).includes(normQuery) ||
          normalizeText(p.objeto).includes(normQuery) ||
          normalizeText(p.entidad).includes(normQuery)
        );
      });

      if (normQuery !== '' && !parentMatches && matchingProcedures.length === 0) {
        return;
      }

      visibleParents++;

      const parentCard = document.createElement('div');
      parentCard.className = 'tree-node-doc';

      const isExpanded = normQuery !== '' || docIdx === 0 || procedures.some((p) => p.id === state.activeProcedureId);
      const chevronClass = isExpanded ? 'bi-chevron-down' : 'bi-chevron-right';
      const collapseClass = isExpanded ? '' : 'd-none';

      const docDate = formatDate(doc.created_at);
      const procCount = procedures.length;

      parentCard.innerHTML = `
        <div class="tree-doc-header" data-doc-id="${doc.id}">
          <div class="d-flex align-items-center text-truncate pe-2" style="max-width: 82%;">
            <i class="bi bi-file-earmark-pdf text-danger fs-5 me-2 flex-shrink-0"></i>
            <div class="text-truncate">
              <div class="fw-bold text-dark small text-truncate" title="${escapeHtml(doc.titulo || 'Convocatoria')}">
                ${escapeHtml(doc.titulo || 'Convocatoria')}
              </div>
              <div class="text-secondary text-truncate" style="font-size: 0.72rem;">
                <span>${escapeHtml(doc.entidad || 'Entidad')}</span> · <span>${docDate}</span>
              </div>
            </div>
          </div>
          <div class="d-flex align-items-center gap-1 flex-shrink-0">
            <span class="badge bg-light text-primary border rounded-pill" style="font-size: 0.7rem;">${procCount} ${procCount === 1 ? 'proc' : 'procs'}</span>
            <i class="bi ${chevronClass} text-secondary fs-6 toggle-arrow"></i>
          </div>
        </div>
        <div class="tree-doc-children ${collapseClass}" id="treeDocChildren_${doc.id}">
          ${
            matchingProcedures.length === 0
              ? '<div class="text-secondary small py-1 fst-italic">Sin procedimientos detectados.</div>'
              : matchingProcedures
                  .map((proc) => {
                    const isActive = proc.id === state.activeProcedureId;
                    const code = escapeHtml(proc.numero_procedimiento || `PROC-${proc.id}`);
                    const title = escapeHtml(proc.titulo || proc.objeto || doc.titulo || 'Licitación');
                    const nextEvt = proc.proximo_evento_nombre
                      ? `<div class="text-truncate mt-1" style="font-size: 0.7rem; color: #b45309;"><i class="bi bi-calendar-event me-1"></i>${escapeHtml(proc.proximo_evento_nombre)}: ${formatDate(proc.proximo_evento_fecha)}</div>`
                      : '';

                    return `
                      <div class="tree-leaf-item ${isActive ? 'active' : ''}" data-proc-id="${proc.id}">
                        <div class="d-flex justify-content-between align-items-start gap-1">
                          <span class="tree-leaf-code fw-bold">${code}</span>
                          <span class="badge border bg-light text-secondary flex-shrink-0" style="font-size: 0.65rem;">${escapeHtml(proc.estado || 'Vigente')}</span>
                        </div>
                        <div class="small fw-semibold text-truncate mt-1" title="${title}">
                          ${title}
                        </div>
                        ${nextEvt}
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      `;

      // Toggle parent collapse
      const headerEl = parentCard.querySelector('.tree-doc-header');
      const childrenEl = parentCard.querySelector('.tree-doc-children');
      const arrowEl = parentCard.querySelector('.toggle-arrow');

      headerEl?.addEventListener('click', () => {
        const isCurrentlyHidden = childrenEl?.classList.contains('d-none');
        if (isCurrentlyHidden) {
          childrenEl?.classList.remove('d-none');
          arrowEl?.classList.replace('bi-chevron-right', 'bi-chevron-down');
        } else {
          childrenEl?.classList.add('d-none');
          arrowEl?.classList.replace('bi-chevron-down', 'bi-chevron-right');
        }
      });

      // Procedure item click
      parentCard.querySelectorAll('.tree-leaf-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const procId = item.getAttribute('data-proc-id');
          if (procId) {
            selectProcedure(procId);
          }
        });
      });

      listEl.appendChild(parentCard);
    });

    if (visibleParents === 0) {
      emptyEl?.classList.remove('d-none');
    } else {
      emptyEl?.classList.add('d-none');
    }
  }

  // Select and Display Procedure Detail
  async function selectProcedure(procedureId) {
    state.activeProcedureId = procedureId;
    window.location.hash = `#proc-${procedureId}`;

    // Highlight active leaf in tree
    document.querySelectorAll('.tree-leaf-item').forEach((el) => {
      const pid = el.getAttribute('data-proc-id');
      if (String(pid) === String(procedureId)) {
        el.classList.add('active');
        const parentContainer = el.closest('.tree-doc-children');
        if (parentContainer?.classList.contains('d-none')) {
          parentContainer.classList.remove('d-none');
          const parentCard = el.closest('.tree-node-doc');
          parentCard?.querySelector('.toggle-arrow')?.classList.replace('bi-chevron-right', 'bi-chevron-down');
        }
      } else {
        el.classList.remove('active');
      }
    });

    document.getElementById('emptyProcedureState')?.classList.add('d-none');
    const detailWrapper = document.getElementById('procedureDetailWrapper');
    detailWrapper?.classList.remove('d-none');

    try {
      let proc = state.cachedProcedures.get(procedureId);
      if (!proc) {
        const res = await fetch(`/api/tenders/procedures/${procedureId}`);
        const data = await res.json();
        if (!data.ok || !data.procedure) {
          throw new Error(data.error || 'No se pudo cargar el detalle del procedimiento');
        }
        proc = data.procedure;
        state.cachedProcedures.set(procedureId, proc);
      }

      renderProcedureDetail(proc);
    } catch (err) {
      console.error('Error al seleccionar procedimiento:', err);
      showAlert(`Error al cargar procedimiento: ${err.message}`, 'danger');
    }
  }

  // Render Full Procedure Detail in Central Panel
  function renderProcedureDetail(proc) {
    const parentTender = proc.parent_tender || {};
    const attachedDocs = proc.parent_documents || [];

    // Header Badges & Titles
    const procCode = proc.numero_procedimiento || `PROC-${proc.id}`;
    const codeBadge = document.getElementById('detailProcCodeBadge');
    if (codeBadge) codeBadge.textContent = procCode;

    const statusBadge = document.getElementById('detailStatusBadge');
    if (statusBadge) statusBadge.textContent = proc.estado || 'Vigente';

    const sourceBadge = document.getElementById('detailSourceBadge');
    if (sourceBadge) sourceBadge.textContent = parentTender.source_nombre || parentTender.fuente_nombre || 'Portal Convocante';

    const titleEl = document.getElementById('detailProcTitle');
    const realTitle = proc.titulo || proc.titulo_objeto || parentTender.titulo || 'Licitación Pública';
    if (titleEl) titleEl.textContent = realTitle;

    const entidadEl = document.getElementById('detailEntidadText');
    if (entidadEl) entidadEl.textContent = proc.entidad || parentTender.entidad || 'Entidad no especificada';

    const sourceLinkEl = document.getElementById('detailSourceUrlLink');
    if (sourceLinkEl) {
      const url = parentTender.source_url || '#';
      sourceLinkEl.href = url;
      sourceLinkEl.textContent = url !== '#' ? url : 'Enlace no disponible';
    }

    // Cronograma & Milestones
    renderCronogramaAndTimeline(proc);

    // Requisitos Obligatorios & Alcance
    renderRequisitosAndAlcance(proc, parentTender);

    // Executive Synthesis
    const synthEl = document.getElementById('detailClaudeSynthesis');
    const synthesisText = proc.sintesis_claude || proc.resumen_ejecutivo || parentTender.sintesis_claude || '';
    if (synthEl) {
      synthEl.innerHTML = renderMarkdown(synthesisText);
    }

    // Persistent PDF Viewer & Attached Documents
    setupPdfViewer(attachedDocs, parentTender);
  }

  // Render Cronograma (WinDOORS Native Timeline + Table)
  function renderCronogramaAndTimeline(proc) {
    const windoorsList = document.getElementById('detailTimelineWindoors');
    const tbodyEl = document.getElementById('detailTimelineTableBody');
    const nextAlertEl = document.getElementById('detailNextMilestoneAlert');
    const nextTextEl = document.getElementById('detailNextMilestoneText');
    const emptyBanner = document.getElementById('timelineEmptyBanner');
    const graphicWrapper = document.getElementById('timelineGraphicWrapper');
    const tableWrapper = document.getElementById('detailTimelineTableWrapper');

    if (!windoorsList || !tbodyEl) return;

    windoorsList.innerHTML = '';
    tbodyEl.innerHTML = '';

    const cronograma = Array.isArray(proc.cronograma) ? proc.cronograma : [];

    // Next milestone highlight badge
    if (proc.proximo_evento_nombre) {
      nextAlertEl?.classList.remove('d-none');
      if (nextTextEl) {
        nextTextEl.textContent = `Próximo: ${proc.proximo_evento_nombre} (${formatDate(proc.proximo_evento_fecha)})`;
      }
    } else {
      nextAlertEl?.classList.add('d-none');
    }

    if (cronograma.length === 0) {
      emptyBanner?.classList.remove('d-none');
      graphicWrapper?.classList.add('d-none');
      tableWrapper?.classList.add('d-none');
      return;
    }

    emptyBanner?.classList.add('d-none');
    if (state.activeTimelineView === 'cards') {
      graphicWrapper?.classList.remove('d-none');
      tableWrapper?.classList.add('d-none');
    } else {
      graphicWrapper?.classList.add('d-none');
      tableWrapper?.classList.remove('d-none');
    }

    const themeColors = ['theme-blue', 'theme-yellow', 'theme-green', 'theme-purple'];

    cronograma.forEach((item, idx) => {
      const eventName = item.evento || item.acto || item.nombre || `Trámite ${idx + 1}`;
      const isCompleted = item.estado === 'completado' || item.completado === true;
      const isUpcoming = item.estado === 'proximo' || (proc.proximo_evento_nombre && eventName.toLowerCase().includes(proc.proximo_evento_nombre.toLowerCase()));

      const themeClass = themeColors[idx % themeColors.length];
      let stepStateClass = 'step-pending';
      let badgeHtml = '<span class="badge bg-secondary">Pendiente</span>';

      if (isCompleted) {
        stepStateClass = 'step-completed';
        badgeHtml = '<span class="badge bg-success"><i class="bi bi-check2 me-1"></i>Completado</span>';
      } else if (isUpcoming) {
        stepStateClass = 'step-upcoming';
        badgeHtml = '<span class="badge bg-primary"><i class="bi bi-clock-history me-1"></i>Próximo</span>';
      }

      // 1. Elemento del Timeline Nativo de WinDOORS (.timeline-windoors.left-only)
      const li = document.createElement('li');
      li.className = `${themeClass} left-timeline ${stepStateClass}`;
      li.innerHTML = `
        <div class="card border-0 mb-3 shadow-sm">
          <div class="card-body p-3">
            <div class="d-flex flex-wrap justify-content-between align-items-center mb-1 gap-2">
              <span class="badge bg-light text-dark border">
                Paso ${idx + 1}
              </span>
              <span class="small fw-bold text-dark">
                <i class="bi bi-calendar3 me-1 text-primary"></i>${formatDate(item.fecha)}
              </span>
            </div>
            <h6 class="fw-bold text-dark mb-1" style="word-break: break-word;">
              ${escapeHtml(eventName)}
            </h6>
            <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mt-2 pt-1 border-top" style="font-size: 0.78rem;">
              <span class="text-secondary">
                <i class="bi bi-clock me-1 text-primary"></i>${escapeHtml(item.hora || 'Hora en bases')}
                <span class="mx-1">·</span>
                <i class="bi bi-geo-alt me-1 text-danger"></i>${escapeHtml(item.lugar || 'Sede oficial / CompraNet')}
              </span>
              <div>${badgeHtml}</div>
            </div>
          </div>
        </div>
      `;
      windoorsList.appendChild(li);

      // 2. Fila de la tabla alternativa
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="fw-semibold text-dark">${escapeHtml(eventName)}</td>
        <td><i class="bi bi-calendar3 text-secondary me-1"></i>${formatDate(item.fecha)}</td>
        <td>${escapeHtml(item.hora || 'No especificada')}</td>
        <td class="text-secondary">${escapeHtml(item.lugar || 'Oficinas convocante / Sistema')}</td>
        <td>${badgeHtml}</td>
      `;
      tbodyEl.appendChild(tr);
    });
  }

  // Render Requisitos Obligatorios & Alcance (Panel ubicado abajo del Cronograma)
  function renderRequisitosAndAlcance(proc, parentTender) {
    const alcanceEl = document.getElementById('detailAlcancePeriodo');
    if (alcanceEl) {
      alcanceEl.textContent =
        proc.alcance_periodo ||
        parentTender.objeto_licitacion ||
        'Conforme a bases, pliego de requisitos técnicos y especificaciones del anexo.';
    }

    const reqContainer = document.getElementById('detailRequisitosList');
    if (!reqContainer) return;
    reqContainer.innerHTML = '';

    const reqs = Array.isArray(proc.requisitos_clave) && proc.requisitos_clave.length > 0
      ? proc.requisitos_clave
      : Array.isArray(parentTender.campos_extraidos_json?.requisitos_clave) && parentTender.campos_extraidos_json.requisitos_clave.length > 0
      ? parentTender.campos_extraidos_json.requisitos_clave
      : [
          'Acreditación de existencia legal y personalidad jurídica del representante.',
          'Opinión positiva de cumplimiento de obligaciones fiscales emitida por el SAT (Artículo 32-D).',
          'Declaración de no encontrarse en los supuestos de inhabilitación ni impedimentos legales.',
          'Garantía de sostenimiento de propuesta y póliza de fianza de cumplimiento.',
          'Constancia de situación fiscal y registro patronal ante el IMSS.',
        ];

    reqs.forEach((r) => {
      const col = document.createElement('div');
      col.className = 'col-12 col-md-6';
      col.innerHTML = `
        <div class="requisito-card h-100 shadow-none">
          <i class="bi bi-check-circle-fill text-success"></i>
          <span>${escapeHtml(r)}</span>
        </div>
      `;
      reqContainer.appendChild(col);
    });
  }

  // Setup In-Situ PDF Viewer Frame & Actions
  function setupPdfViewer(attachedDocs, parentTender) {
    const viewerFrame = document.getElementById('detailPdfViewerFrame');
    const titleEl = document.getElementById('detailViewerDocTitle');
    const metaEl = document.getElementById('detailViewerDocMeta');
    const newTabLink = document.getElementById('detailViewerNewTabLink');
    const downloadLink = document.getElementById('detailViewerDownloadLink');

    if (!attachedDocs || attachedDocs.length === 0) {
      state.activeDocId = null;
      if (titleEl) titleEl.textContent = parentTender.titulo || 'Expediente Web';
      if (metaEl) metaEl.textContent = 'Este registro proviene de contenido web directo o aún no tiene PDF descargado.';
      if (viewerFrame) {
        // Mostrar enlace al portal web si no hay PDF
        viewerFrame.src = parentTender.source_url || 'about:blank';
      }
      if (newTabLink) newTabLink.href = parentTender.source_url || '#';
      if (downloadLink) downloadLink.href = parentTender.source_url || '#';
      return;
    }

    const pdfDoc = attachedDocs.find((d) => d.file_type === 'pdf') || attachedDocs[0];
    state.activeDocId = pdfDoc.id;

    const downloadUrl = `/api/tenders/documents/${pdfDoc.id}/download`;

    if (titleEl) titleEl.textContent = pdfDoc.file_name || `Documento #${pdfDoc.id}`;
    if (metaEl) {
      const sizeKb = pdfDoc.file_size_bytes ? Math.round(pdfDoc.file_size_bytes / 1024) : 0;
      const ocrTag = pdfDoc.metodo_extraccion ? ` · Extracción: ${pdfDoc.metodo_extraccion}` : '';
      metaEl.textContent = `${sizeKb > 0 ? sizeKb + ' KB' : 'Documento'} · ${pdfDoc.file_type || 'pdf'}${ocrTag}`;
    }

    if (viewerFrame) viewerFrame.src = downloadUrl;
    if (newTabLink) newTabLink.href = downloadUrl;
    if (downloadLink) downloadLink.href = downloadUrl;
  }

  // Inspect Raw OCR Text (Modal) - NUNCA falla si no hay PDF
  async function openRawOcrModal() {
    if (!state.activeProcedureId) {
      showAlert('Selecciona una licitación para inspeccionar su texto extraído.', 'warning');
      return;
    }

    const preEl = document.getElementById('rawOcrTextPre');
    const metaEl = document.getElementById('rawOcrModalMeta');

    if (preEl) preEl.textContent = 'Obteniendo transcripción OCR / Web desde PostgreSQL...';
    if (metaEl) metaEl.textContent = `Procedimiento #${state.activeProcedureId}`;

    const modalEl = document.getElementById('rawOcrModal');
    if (window.bootstrap?.Modal) {
      const modalInstance = window.bootstrap.Modal.getOrCreateInstance(modalEl);
      modalInstance.show();
    }

    try {
      const res = await fetch(`/api/tenders/procedures/${state.activeProcedureId}/raw-text`);
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.message || data.error || 'No se pudo obtener el texto');
      }

      const fullText = data.raw_text || '';
      if (preEl) {
        preEl.textContent = fullText.length > 0 ? fullText : '(El expediente se encuentra vacío).';
      }
      if (metaEl) {
        metaEl.textContent = `${data.nombre_archivo} · Fuente: ${data.metodo_extraccion || 'N/A'} · ${Number(data.caracteres_totales || fullText.length).toLocaleString()} caracteres extraídos`;
      }
    } catch (err) {
      if (preEl) preEl.textContent = `Error al cargar texto: ${err.message}`;
    }
  }

  // Extraer Cronograma de Fechas con Claude IA
  async function extractTimelineWithIa() {
    if (!state.activeProcedureId) {
      showAlert('Selecciona una licitación primero.', 'warning');
      return;
    }

    const btn = document.getElementById('btnExtractTimelineIa');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span>Analizando fechas...';
    }

    try {
      showAlert('Analizando el documento con Claude para extraer todos los actos del cronograma...', 'info');
      const res = await fetch(`/api/tenders/procedures/${state.activeProcedureId}/extract-timeline`, {
        method: 'POST',
      });
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.message || 'Error al extraer cronograma');
      }

      showAlert('¡Cronograma y requisitos extraídos y guardados con éxito!', 'success');

      // Invalidar cache y refrescar
      state.cachedProcedures.delete(state.activeProcedureId);
      await selectProcedure(state.activeProcedureId);
      await loadTendersTree(true);
    } catch (err) {
      showAlert(`Error en extracción de cronograma: ${err.message}`, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  // Diagnostics: Test Surya OCR & Python Environment
  async function runOcrDiagnostics() {
    try {
      showAlert('Ejecutando diagnóstico de Surya OCR y dependencias...', 'info');
      const res = await fetch('/api/tenders/ocr/diagnostics');
      const data = await res.json();

      if (data.ok) {
        const diag = data.diagnostics || data;
        const msg = `Diagnóstico OCR: Python: ${diag.python_bin || 'Activo'} | Surya OCR: ${diag.surya_script_ready ? 'Instalado' : 'No encontrado'} | Tesseract: ${diag.tesseract_available ? 'Presente' : 'No detectado'}`;
        showAlert(msg, 'success');
      } else {
        showAlert(`Diagnóstico OCR: ${data.message || 'Fallo general'}`, 'warning');
      }
    } catch (err) {
      showAlert(`Error ejecutando diagnóstico: ${err.message}`, 'danger');
    }
  }

  // Ingest URL Form Submit
  async function handleIngestFormSubmit(e) {
    e.preventDefault();
    if (state.isIngesting) return;

    const urlInput = document.getElementById('tenderUrlInput');
    const kwInput = document.getElementById('tenderKeywordsInput');
    const processAttachSwitch = document.getElementById('processAttachmentsSwitch');
    const reqAuthSwitch = document.getElementById('requiresAuthSwitch');
    const userInput = document.getElementById('authUsernameInput');
    const passInput = document.getElementById('authPasswordInput');
    const loginUrlInput = document.getElementById('authLoginUrlInput');
    const submitBtn = document.getElementById('btnIngestUrl');

    const targetUrl = urlInput?.value.trim();
    if (!targetUrl) {
      showAlert('Por favor ingresa una URL válida.', 'warning');
      return;
    }

    state.isIngesting = true;
    const originalBtnHtml = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Extrayendo y analizando...';
    }

    try {
      showAlert('Iniciando extracción con Lightpanda y análisis de Surya OCR / Claude...', 'info');

      const payload = {
        url: targetUrl,
        keywords: kwInput?.value.trim() || undefined,
        process_attachments: processAttachSwitch ? processAttachSwitch.checked : true,
      };

      if (reqAuthSwitch && reqAuthSwitch.checked && userInput?.value) {
        payload.credentials = {
          username: userInput.value.trim(),
          password: passInput?.value || '',
          login_url: loginUrlInput?.value.trim() || undefined,
        };
      }

      const res = await fetch('/api/tenders/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.message || data.error || 'Error al procesar la licitación');
      }

      showAlert(`¡Extracción completada con éxito! Licitación #${data.tender_id} agregada al catálogo.`, 'success');

      state.cachedProcedures.clear();
      await loadTendersTree(false);

      if (data.tender_id) {
        const matchingParent = state.treeData.find((p) => p.id === data.tender_id);
        if (matchingParent && matchingParent.procedures?.length > 0) {
          selectProcedure(matchingParent.procedures[0].id);
        }
      }
    } catch (err) {
      console.error('Error al ingerir URL:', err);
      showAlert(`Error en la extracción: ${err.message}`, 'danger');
    } finally {
      state.isIngesting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHtml;
      }
    }
  }

  // Copy Raw OCR to Clipboard
  function copyRawOcrToClipboard() {
    const preEl = document.getElementById('rawOcrTextPre');
    const copyBtn = document.getElementById('btnCopyRawOcr');
    if (!preEl) return;

    navigator.clipboard.writeText(preEl.textContent || '').then(() => {
      if (copyBtn) {
        const orig = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i class="bi bi-check-lg me-1 text-success"></i> ¡Copiado!';
        setTimeout(() => {
          copyBtn.innerHTML = orig;
        }, 2000);
      }
    });
  }

  // Initialize
  function init() {
    // Auth Switch Toggle
    const reqAuthSwitch = document.getElementById('requiresAuthSwitch');
    const authBox = document.getElementById('authCredentialsBox');
    reqAuthSwitch?.addEventListener('change', () => {
      if (reqAuthSwitch.checked) {
        authBox?.classList.remove('d-none');
      } else {
        authBox?.classList.add('d-none');
      }
    });

    // Ingest Form
    const ingestForm = document.getElementById('ingestUrlForm');
    ingestForm?.addEventListener('submit', handleIngestFormSubmit);

    // Tree Search Filter (with client debounce)
    const searchInput = document.getElementById('treeSearchInput');
    let searchDebounce = null;
    searchInput?.addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        renderTree(e.target.value);
      }, 250);
    });

    // Refresh Tree Button
    document.getElementById('btnRefreshTree')?.addEventListener('click', () => {
      state.cachedProcedures.clear();
      loadTendersTree(true);
    });

    // Raw OCR Modal Button
    document.getElementById('btnViewRawOcr')?.addEventListener('click', openRawOcrModal);
    document.getElementById('btnCopyRawOcr')?.addEventListener('click', copyRawOcrToClipboard);

    // Diagnostics Button
    document.getElementById('btnOcrDiagnostics')?.addEventListener('click', runOcrDiagnostics);

    // Extract Timeline Button
    document.getElementById('btnExtractTimelineIa')?.addEventListener('click', extractTimelineWithIa);
    document.getElementById('btnReanalyzeProc')?.addEventListener('click', extractTimelineWithIa);

    // Timeline View Switchers
    const btnTimelineCards = document.getElementById('btnTimelineViewCards');
    const btnTimelineTable = document.getElementById('btnTimelineViewTable');
    const graphicWrapper = document.getElementById('timelineGraphicWrapper');
    const tableWrapper = document.getElementById('detailTimelineTableWrapper');

    btnTimelineCards?.addEventListener('click', () => {
      state.activeTimelineView = 'cards';
      btnTimelineCards.classList.add('active');
      btnTimelineTable?.classList.remove('active');
      graphicWrapper?.classList.remove('d-none');
      tableWrapper?.classList.add('d-none');
    });

    btnTimelineTable?.addEventListener('click', () => {
      state.activeTimelineView = 'table';
      btnTimelineTable.classList.add('active');
      btnTimelineCards?.classList.remove('active');
      graphicWrapper?.classList.add('d-none');
      tableWrapper?.classList.remove('d-none');
    });

    // Scroll to PDF Viewer Card Button
    document.getElementById('btnToggleViewerCard')?.addEventListener('click', () => {
      const card = document.getElementById('detailPdfViewerCard');
      card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Initial Loads
    loadPipelineStatus();
    loadTendersTree();

    // Background poll every 60s
    setInterval(() => {
      loadTendersTree(true);
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
