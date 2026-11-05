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
    // Fix multiple adjacent ul
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

      // If target exists in tree, select it; otherwise select the very first procedure
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
        normalizeText(doc.entidad_convocante).includes(normQuery);

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
        return; // filter out
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
          <div class="d-flex align-items-center text-truncate pe-2">
            <i class="bi bi-file-earmark-pdf text-danger fs-5 me-2 flex-shrink-0"></i>
            <div class="text-truncate">
              <div class="fw-bold text-dark small text-truncate" title="${escapeHtml(doc.titulo || 'Convocatoria')}">
                ${escapeHtml(doc.titulo || 'Convocatoria sin título')}
              </div>
              <div class="text-secondary" style="font-size: 0.75rem;">
                <span>${escapeHtml(doc.entidad_convocante || 'Entidad')}</span> · <span>${docDate}</span>
              </div>
            </div>
          </div>
          <div class="d-flex align-items-center gap-1 flex-shrink-0">
            <span class="badge bg-light text-primary border rounded-pill" style="font-size: 0.72rem;">${procCount} ${procCount === 1 ? 'proc' : 'procs'}</span>
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
                    const title = escapeHtml(proc.titulo || proc.objeto || 'Sin descripción');
                    const nextEvt = proc.proximo_evento_nombre
                      ? `<div class="text-truncate mt-1" style="font-size: 0.72rem; color: #b45309;"><i class="bi bi-calendar-event me-1"></i>${escapeHtml(proc.proximo_evento_nombre)}: ${formatDate(proc.proximo_evento_fecha)}</div>`
                      : '';

                    return `
                      <div class="tree-leaf-item ${isActive ? 'active' : ''}" data-proc-id="${proc.id}">
                        <div class="d-flex justify-content-between align-items-center">
                          <span class="badge bg-primary text-white" style="font-size: 0.72rem;">${code}</span>
                          <span class="badge bg-light text-secondary border" style="font-size: 0.68rem;">${escapeHtml(proc.estado || 'Vigente')}</span>
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

      // Event listener: Toggle parent collapse
      const headerEl = parentCard.querySelector('.tree-doc-header');
      const childrenEl = parentCard.querySelector('.tree-doc-children');
      const arrowEl = parentCard.querySelector('.toggle-arrow');

      headerEl?.addEventListener('click', (e) => {
        // Toggle children visibility
        const isCurrentlyHidden = childrenEl?.classList.contains('d-none');
        if (isCurrentlyHidden) {
          childrenEl?.classList.remove('d-none');
          arrowEl?.classList.replace('bi-chevron-right', 'bi-chevron-down');
        } else {
          childrenEl?.classList.add('d-none');
          arrowEl?.classList.replace('bi-chevron-down', 'bi-chevron-right');
        }
      });

      // Event listeners: Procedure item click
      parentCard.querySelectorAll('.tree-leaf-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const procId = parseInt(item.getAttribute('data-proc-id'), 10);
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
      const pid = parseInt(el.getAttribute('data-proc-id'), 10);
      if (pid === procedureId) {
        el.classList.add('active');
        // Ensure its parent container is expanded
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

    // Show detail panel, hide empty state
    document.getElementById('emptyProcedureState')?.classList.add('d-none');
    const detailWrapper = document.getElementById('procedureDetailWrapper');
    detailWrapper?.classList.remove('d-none');

    // Fetch full procedure detail
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
    if (sourceBadge) sourceBadge.textContent = parentTender.fuente_nombre || 'Portal Convocante';

    const titleEl = document.getElementById('detailProcTitle');
    if (titleEl) titleEl.textContent = proc.titulo || proc.objeto || 'Procedimiento sin título';

    const entidadEl = document.getElementById('detailEntidadText');
    if (entidadEl) entidadEl.textContent = proc.entidad || parentTender.entidad_convocante || 'Entidad no especificada';

    const sourceLinkEl = document.getElementById('detailSourceUrlLink');
    if (sourceLinkEl) {
      const url = parentTender.url_fuente || '#';
      sourceLinkEl.href = url;
      sourceLinkEl.textContent = url !== '#' ? url : 'Enlace no disponible';
    }

    // Cronograma & Milestones
    renderCronogramaAndTimeline(proc);

    // Executive Synthesis
    const synthEl = document.getElementById('detailClaudeSynthesis');
    const synthesisText = proc.resumen_ejecutivo || parentTender.resumen_ejecutivo || '';
    if (synthEl) {
      synthEl.innerHTML = renderMarkdown(synthesisText);
    }

    // Alcance y Periodo del Contrato (reemplaza presupuesto)
    const alcanceEl = document.getElementById('detailAlcancePeriodo');
    if (alcanceEl) {
      alcanceEl.textContent = proc.alcance_periodo || parentTender.objeto_licitacion || 'Especificado en pliego de requisitos técnicos y catálogo de conceptos.';
    }
    const presNotaEl = document.getElementById('detailPresupuestoNota');
    if (presNotaEl) {
      presNotaEl.textContent = 'En apego a la normatividad de adquisiciones públicas, la suficiencia presupuestal es de carácter reservado; la oferta se evalúa por precio unitario.';
    }

    // Requisitos Clave
    const reqListEl = document.getElementById('detailRequisitosList');
    if (reqListEl) {
      reqListEl.innerHTML = '';
      const reqs = Array.isArray(proc.requisitos_clave) && proc.requisitos_clave.length > 0
        ? proc.requisitos_clave
        : Array.isArray(parentTender.requisitos_clave) && parentTender.requisitos_clave.length > 0
        ? parentTender.requisitos_clave
        : ['Presentar acreditación de existencia legal', 'Garantía de seriedad de propuesta', 'Opinión de cumplimiento SAT en sentido positivo (32-D)'];

      reqs.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'list-group-item px-0 py-2 border-0 d-flex align-items-start';
        li.innerHTML = `<i class="bi bi-check2-circle text-success me-2 mt-1 flex-shrink-0"></i><span>${escapeHtml(r)}</span>`;
        reqListEl.appendChild(li);
      });
    }

    // Persistent PDF Viewer & Attached Documents
    setupPdfViewer(attachedDocs, proc);
  }

  // Render Visual Timeline Stepper & Table
  function renderCronogramaAndTimeline(proc) {
    const stepperEl = document.getElementById('detailTimelineStepper');
    const tbodyEl = document.getElementById('detailTimelineTableBody');
    const nextAlertEl = document.getElementById('detailNextMilestoneAlert');
    const nextTextEl = document.getElementById('detailNextMilestoneText');

    if (!stepperEl || !tbodyEl) return;

    stepperEl.innerHTML = '';
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
      stepperEl.innerHTML = `
        <div class="text-secondary small p-3 bg-light rounded text-center w-100">
          <i class="bi bi-info-circle me-1"></i> No se detectaron fechas específicas de calendario en el extracto analizado.
        </div>
      `;
      tbodyEl.innerHTML = `
        <tr>
          <td colspan="5" class="text-center text-secondary py-3">Sin trámites programados en base de datos.</td>
        </tr>
      `;
      return;
    }

    // Sort or preserve chronological order
    cronograma.forEach((item, idx) => {
      const isCompleted = item.completado === true;
      const isNext = proc.proximo_evento_nombre && item.acto && item.acto.toLowerCase().includes(proc.proximo_evento_nombre.toLowerCase());

      let stepClass = 'timeline-step';
      let icon = 'bi-circle';
      let badgeHtml = '<span class="badge bg-secondary">Pendiente</span>';

      if (isCompleted) {
        stepClass += ' completed';
        icon = 'bi-check-circle-fill text-success';
        badgeHtml = '<span class="badge bg-success">Completado</span>';
      } else if (isNext) {
        stepClass += ' upcoming';
        icon = 'bi-clock-fill text-primary';
        badgeHtml = '<span class="badge bg-primary">Próximo</span>';
      }

      // Stepper card
      const stepDiv = document.createElement('div');
      stepDiv.className = stepClass;
      stepDiv.innerHTML = `
        <div class="d-flex align-items-center justify-content-between mb-1">
          <span class="small fw-bold text-secondary">Paso ${idx + 1}</span>
          <i class="bi ${icon}"></i>
        </div>
        <div class="fw-bold text-dark small text-truncate" title="${escapeHtml(item.acto)}">
          ${escapeHtml(item.acto)}
        </div>
        <div class="text-primary small fw-semibold mt-1">
          <i class="bi bi-calendar3 me-1"></i>${formatDate(item.fecha)}
        </div>
        <div class="text-secondary" style="font-size: 0.72rem;">
          ${escapeHtml(item.hora || 'Hora en bases')}
        </div>
      `;
      stepperEl.appendChild(stepDiv);

      // Table row
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="fw-semibold text-dark">${escapeHtml(item.acto)}</td>
        <td><i class="bi bi-calendar3 text-secondary me-1"></i>${formatDate(item.fecha)}</td>
        <td>${escapeHtml(item.hora || 'No especificada')}</td>
        <td class="text-secondary">${escapeHtml(item.lugar || 'Oficinas convocante / Sistema')}</td>
        <td>${badgeHtml}</td>
      `;
      tbodyEl.appendChild(tr);
    });
  }

  // Setup In-Situ PDF Viewer Frame & Actions
  function setupPdfViewer(attachedDocs, proc) {
    const viewerCard = document.getElementById('detailPdfViewerCard');
    const viewerFrame = document.getElementById('detailPdfViewerFrame');
    const titleEl = document.getElementById('detailViewerDocTitle');
    const metaEl = document.getElementById('detailViewerDocMeta');
    const newTabLink = document.getElementById('detailViewerNewTabLink');
    const downloadLink = document.getElementById('detailViewerDownloadLink');

    if (!attachedDocs || attachedDocs.length === 0) {
      state.activeDocId = null;
      if (titleEl) titleEl.textContent = 'Sin documento adjunto';
      if (metaEl) metaEl.textContent = 'Este registro proviene de contenido web directo o aún no tiene PDF vinculado.';
      if (viewerFrame) viewerFrame.src = 'about:blank';
      if (newTabLink) newTabLink.href = '#';
      if (downloadLink) downloadLink.href = '#';
      return;
    }

    // Pick first PDF or first doc
    const pdfDoc = attachedDocs.find((d) => d.mime_type === 'application/pdf') || attachedDocs[0];
    state.activeDocId = pdfDoc.id;

    const downloadUrl = `/api/tenders/documents/${pdfDoc.id}/download`;

    if (titleEl) titleEl.textContent = pdfDoc.nombre_archivo || `Documento #${pdfDoc.id}`;
    if (metaEl) {
      const sizeKb = pdfDoc.tamano_bytes ? Math.round(pdfDoc.tamano_bytes / 1024) : 0;
      const ocrTag = pdfDoc.metodo_extraccion ? ` · Extracción: ${pdfDoc.metodo_extraccion}` : '';
      metaEl.textContent = `${sizeKb > 0 ? sizeKb + ' KB' : 'PDF'} · ${pdfDoc.mime_type || 'application/pdf'}${ocrTag}`;
    }

    if (viewerFrame) {
      viewerFrame.src = downloadUrl;
    }
    if (newTabLink) {
      newTabLink.href = downloadUrl;
    }
    if (downloadLink) {
      downloadLink.href = downloadUrl;
    }
  }

  // Inspect Raw OCR Text (Modal)
  async function openRawOcrModal() {
    if (!state.activeDocId) {
      showAlert('No hay un documento PDF activo seleccionado para inspeccionar su texto OCR.', 'warning');
      return;
    }

    const preEl = document.getElementById('rawOcrTextPre');
    const metaEl = document.getElementById('rawOcrModalMeta');

    if (preEl) preEl.textContent = 'Obteniendo transcripción OCR desde PostgreSQL...';
    if (metaEl) metaEl.textContent = `Documento ID #${state.activeDocId}`;

    const modalEl = document.getElementById('rawOcrModal');
    let modalInstance = null;
    if (window.bootstrap?.Modal) {
      modalInstance = window.bootstrap.Modal.getOrCreateInstance(modalEl);
      modalInstance.show();
    }

    try {
      const res = await fetch(`/api/tenders/documents/${state.activeDocId}/raw-text`);
      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || 'No se pudo obtener el texto OCR');
      }

      const fullText = data.raw_text || '';
      if (preEl) {
        preEl.textContent = fullText.length > 0 ? fullText : '(El documento no contiene texto extraído o se encuentra vacío).';
      }
      if (metaEl) {
        metaEl.textContent = `${data.nombre_archivo} · Método: ${data.metodo_extraccion || 'N/A'} · ${data.caracteres_totales.toLocaleString()} caracteres extraídos`;
      }
    } catch (err) {
      if (preEl) preEl.textContent = `Error al cargar texto OCR: ${err.message}`;
    }
  }

  // Diagnostics: Test Surya OCR & Python Environment
  async function runOcrDiagnostics() {
    try {
      showAlert('Ejecutando diagnóstico de Surya OCR y dependencias...', 'info');
      const res = await fetch('/api/tenders/ocr/diagnostics');
      const data = await res.json();

      if (data.ok) {
        const diag = data.diagnostics;
        const msg = `Diagnóstico OCR: Python 3: ${diag.python3_version} | Surya OCR: ${diag.surya_script_exists ? 'Instalado' : 'No encontrado'} | Tesseract: ${diag.tesseract_installed ? 'Presente' : 'No detectado'} | pypdfium2: ${diag.pypdfium2_installed ? 'Presente' : 'No detectado'}`;
        showAlert(msg, 'success');
      } else {
        showAlert(`Diagnóstico OCR con advertencias: ${data.error || 'Fallo general'}`, 'warning');
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
        throw new Error(data.error || 'Error al procesar la licitación');
      }

      showAlert(`¡Extracción completada con éxito! Licitación #${data.tender_id} agregada al catálogo.`, 'success');

      // Clear cached procedures and reload tree
      state.cachedProcedures.clear();
      await loadTendersTree(false);

      // Auto-select the newly ingested tender if procedures exist
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
