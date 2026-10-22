/**
 * Scrapper — Administración de Fuentes de Interés (Altas, Bajas, Cambios, Credenciales y Ejecución)
 */
(function () {
  'use strict';

  const state = {
    sources: [],
    runs: [],
  };

  function showAlert(message, type = 'success') {
    const el = document.getElementById('sourcesFeedbackAlert');
    if (!el) return;
    el.className = `alert alert-${type} border-0 shadow-sm mb-3`;
    el.innerHTML = `<div class="d-flex align-items-center justify-content-between">
      <span>${message}</span>
      <button type="button" class="btn-close" onclick="this.parentElement.parentElement.classList.add('d-none')"></button>
    </div>`;
    el.classList.remove('d-none');
  }

  function formatFreq(hours) {
    const h = Number(hours || 24);
    if (h === 6) return 'Cada 6 h';
    if (h === 12) return 'Cada 12 h';
    if (h === 24) return 'Diario (24 h)';
    if (h === 48) return 'Cada 48 h';
    if (h === 168) return 'Semanal (7 d)';
    return `Cada ${h} h`;
  }

  function formatStatusBadge(estado) {
    if (estado === 'ejecutando') {
      return `<span class="badge bg-primary"><span class="spinner-border spinner-border-sm me-1" style="width:0.7rem;height:0.7rem;"></span>Ejecutando</span>`;
    }
    if (estado === 'exito') {
      return `<span class="badge bg-success">Éxito</span>`;
    }
    if (estado === 'error') {
      return `<span class="badge bg-danger">Error</span>`;
    }
    return `<span class="badge bg-secondary">Pendiente</span>`;
  }

  async function loadSourcesAndRuns() {
    try {
      const res = await fetch('/api/sources');
      const data = await res.json();
      if (!data.ok) return;

      state.sources = data.sources || [];
      state.runs = data.runs || [];

      const activeCount = state.sources.filter((s) => Boolean(s.activo)).length;
      const sideCount = document.getElementById('sidebarActiveSourcesCount');
      if (sideCount) sideCount.textContent = `${activeCount} / ${state.sources.length}`;

      renderSourcesTable();
      renderRunsTable();
    } catch {
      // ignore
    }
  }

  function renderSourcesTable() {
    const tbody = document.getElementById('sourcesTableBody');
    if (!tbody) return;

    if (state.sources.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-secondary py-4">No hay fuentes registradas. Haz clic en "Nueva Fuente de Interés".</td></tr>`;
      return;
    }

    tbody.innerHTML = state.sources
      .map((s) => {
        const kwBadges = String(s.keywords || '')
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
          .map((k) => `<span class="badge bg-light text-dark border me-1 mb-1">${k}</span>`)
          .join('');

        const authBadge = s.requiere_auth
          ? `<span class="badge bg-info text-dark ms-1" title="Usuario: ${s.auth_username || ''}"><i class="bi bi-shield-lock-fill me-1"></i>Con credenciales (${s.auth_username || 'usuario'})</span>`
          : '';

        const lastRev = s.ultima_revision_at
          ? new Date(s.ultima_revision_at).toLocaleString()
          : 'Sin ejecutar aún';

        return `<tr>
          <td>
            <div class="form-check form-switch mb-0">
              <input class="form-check-input toggle-source-switch" type="checkbox" data-id="${s.id}" ${s.activo ? 'checked' : ''} style="cursor:pointer;">
            </div>
          </td>
          <td>
            <div class="fw-bold text-dark">${s.nombre} ${authBadge}</div>
            <div class="small text-secondary">${s.entidad || ''}</div>
            <a href="${s.url}" target="_blank" class="small text-theme text-truncate d-block" style="max-width: 300px;">${s.url}</a>
          </td>
          <td style="max-width: 240px;">${kwBadges}</td>
          <td class="text-nowrap">
            <span class="fw-medium">${formatFreq(s.frecuencia_horas)}</span>
          </td>
          <td style="max-width: 240px;">
            <div class="mb-1">${formatStatusBadge(s.ultimo_estado)} <span class="text-secondary ms-1">${lastRev}</span></div>
            <div class="text-secondary small text-truncate" title="${s.ultimo_mensaje || ''}">${s.ultimo_mensaje || ''}</div>
          </td>
          <td class="text-center">
            <span class="badge bg-light text-dark border fs-6">${s.total_licitaciones_encontradas || 0}</span>
          </td>
          <td class="text-end text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-success btn-run-source" data-id="${s.id}" title="Ejecutar ahora">
              <i class="bi bi-play-fill"></i> Ejecutar
            </button>
            <button type="button" class="btn btn-sm btn-outline-primary btn-edit-source ms-1" data-id="${s.id}" title="Editar fuente y credenciales">
              <i class="bi bi-pencil-square"></i> Editar
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger btn-delete-source ms-1" data-id="${s.id}" title="Eliminar fuente">
              <i class="bi bi-trash"></i>
            </button>
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('.toggle-source-switch').forEach((sw) => {
      sw.addEventListener('change', async () => {
        const id = Number(sw.getAttribute('data-id'));
        const activo = Boolean(sw.checked);
        await fetch(`/api/sources/${id}/toggle`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activo }),
        });
        await loadSourcesAndRuns();
      });
    });

    tbody.querySelectorAll('.btn-run-source').forEach((btn) => {
      btn.addEventListener('click', () => handleRunSingleSource(Number(btn.getAttribute('data-id')), btn));
    });

    tbody.querySelectorAll('.btn-edit-source').forEach((btn) => {
      btn.addEventListener('click', () => openSourceEditorForEdit(Number(btn.getAttribute('data-id'))));
    });

    tbody.querySelectorAll('.btn-delete-source').forEach((btn) => {
      btn.addEventListener('click', () => handleDeleteSource(Number(btn.getAttribute('data-id'))));
    });
  }

  function renderRunsTable() {
    const tbody = document.getElementById('runsTableBody');
    if (!tbody) return;

    if (state.runs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-secondary py-3">Sin ejecuciones registradas aún. Usa el botón "Ejecutar" en cualquier fuente.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.runs
      .map((r) => {
        const sec = (Number(r.duracion_ms || 0) / 1000).toFixed(1);
        return `<tr>
          <td class="text-nowrap">${new Date(r.created_at).toLocaleString()}</td>
          <td class="fw-medium text-dark">${r.source_nombre || `#${r.source_id}`}</td>
          <td><span class="badge bg-light text-dark border">${r.disparo}</span></td>
          <td>${formatStatusBadge(r.estado)}</td>
          <td class="text-center">${r.hits_detectados || 0}</td>
          <td class="text-center fw-bold text-success">${r.licitaciones_nuevas || 0}</td>
          <td class="text-center text-secondary">${r.licitaciones_duplicadas || 0}</td>
          <td class="text-end text-nowrap">${sec}s</td>
          <td class="small text-secondary">${r.error_detalle || r.mensaje_log || '-'}</td>
        </tr>`;
      })
      .join('');
  }

  function openSourceEditorForNew() {
    const card = document.getElementById('sourceEditorCard');
    const title = document.getElementById('sourceEditorTitle');
    if (!card) return;

    document.getElementById('editSourceId').value = '';
    document.getElementById('srcNombreInput').value = '';
    document.getElementById('srcEntidadInput').value = '';
    document.getElementById('srcUrlInput').value = '';
    document.getElementById('srcKeywordsInput').value = 'mantenimiento, desarrollo, adquisición';
    document.getElementById('srcFrecuenciaSelect').value = '24';
    document.getElementById('srcActivoSwitch').checked = true;
    document.getElementById('srcRequiresAuthSwitch').checked = false;
    document.getElementById('srcAuthUserInput').value = '';
    document.getElementById('srcAuthPassInput').value = '';
    document.getElementById('srcAuthPassInput').placeholder = 'Escribe la contraseña del portal';
    document.getElementById('srcPassSavedBadge')?.classList.add('d-none');
    document.getElementById('srcAuthLoginUrlInput').value = '';
    document.getElementById('srcAuthFieldsBox')?.classList.add('d-none');

    if (title) {
      title.innerHTML = `<i class="bi bi-plus-circle text-theme me-1"></i> Alta de Nueva Fuente de Interés`;
    }
    card.classList.remove('d-none');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openSourceEditorForEdit(id) {
    const source = state.sources.find((s) => s.id === id);
    if (!source) return;

    const card = document.getElementById('sourceEditorCard');
    const title = document.getElementById('sourceEditorTitle');
    if (!card) return;

    document.getElementById('editSourceId').value = String(source.id);
    document.getElementById('srcNombreInput').value = source.nombre || '';
    document.getElementById('srcEntidadInput').value = source.entidad || '';
    document.getElementById('srcUrlInput').value = source.url || '';
    document.getElementById('srcKeywordsInput').value = source.keywords || '';
    document.getElementById('srcFrecuenciaSelect').value = String(source.frecuencia_horas || 24);
    document.getElementById('srcActivoSwitch').checked = Boolean(source.activo);
    document.getElementById('srcRequiresAuthSwitch').checked = Boolean(source.requiere_auth);
    document.getElementById('srcAuthUserInput').value = source.auth_username || '';
    document.getElementById('srcAuthPassInput').value = '';
    document.getElementById('srcAuthPassInput').placeholder = source.has_password
      ? `${source.auth_password_masked || '••••••••'} (dejar vacío para conservar actual)`
      : 'Escribe la contraseña del portal';

    const passBadge = document.getElementById('srcPassSavedBadge');
    if (passBadge) {
      if (source.has_password) {
        passBadge.classList.remove('d-none');
      } else {
        passBadge.classList.add('d-none');
      }
    }

    document.getElementById('srcAuthLoginUrlInput').value = source.auth_login_url || '';

    const authBox = document.getElementById('srcAuthFieldsBox');
    if (source.requiere_auth) {
      authBox?.classList.remove('d-none');
    } else {
      authBox?.classList.add('d-none');
    }

    if (title) {
      title.innerHTML = `<i class="bi bi-pencil-square text-theme me-1"></i> Editar Fuente #${source.id}: ${source.nombre}`;
    }
    card.classList.remove('d-none');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeSourceEditor() {
    document.getElementById('sourceEditorCard')?.classList.add('d-none');
  }

  async function handleSaveSource(e) {
    e.preventDefault();
    const editId = document.getElementById('editSourceId')?.value?.trim() || '';
    const nombre = document.getElementById('srcNombreInput')?.value?.trim() || '';
    const entidad = document.getElementById('srcEntidadInput')?.value?.trim() || '';
    const url = document.getElementById('srcUrlInput')?.value?.trim() || '';
    const keywords = document.getElementById('srcKeywordsInput')?.value?.trim() || '';
    const frecuencia_horas = Number(document.getElementById('srcFrecuenciaSelect')?.value || 24);
    const activo = Boolean(document.getElementById('srcActivoSwitch')?.checked);
    const requiere_auth = Boolean(document.getElementById('srcRequiresAuthSwitch')?.checked);
    const auth_username = document.getElementById('srcAuthUserInput')?.value?.trim() || '';
    const auth_password = document.getElementById('srcAuthPassInput')?.value || '';
    const auth_login_url = document.getElementById('srcAuthLoginUrlInput')?.value?.trim() || '';

    if (!nombre || !url || !keywords) {
      showAlert('Completa el Nombre, la URL y las Palabras Clave.', 'warning');
      return;
    }

    const endpoint = editId ? `/api/sources/${editId}` : '/api/sources';
    const method = editId ? 'PUT' : 'POST';

    try {
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre,
          entidad,
          url,
          keywords,
          frecuencia_horas,
          activo,
          requiere_auth,
          auth_username,
          auth_password,
          auth_login_url,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showAlert(data.message || 'No se pudo guardar la fuente.', 'danger');
        return;
      }

      closeSourceEditor();
      showAlert(data.message || 'Fuente guardada correctamente.', 'success');
      await loadSourcesAndRuns();
    } catch (err) {
      showAlert('Error de red al guardar la fuente: ' + err.message, 'danger');
    }
  }

  async function handleDeleteSource(id) {
    const source = state.sources.find((s) => s.id === id);
    if (!source) return;
    if (!window.confirm(`¿Eliminar la fuente "${source.nombre}"?`)) return;

    try {
      const res = await fetch(`/api/sources/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        showAlert('Fuente eliminada correctamente.', 'success');
        await loadSourcesAndRuns();
      }
    } catch (err) {
      showAlert('Error al eliminar la fuente: ' + err.message, 'danger');
    }
  }

  async function handleRunSingleSource(id, btn) {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span>`;
    }
    showAlert('Ejecutando revisión de la fuente seleccionada...', 'info');
    loadSourcesAndRuns();

    try {
      const res = await fetch(`/api/sources/${id}/run-now`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showAlert(data.message || 'Error al ejecutar la fuente.', 'danger');
      } else {
        showAlert(`Revisión completada: ${data.message}`, 'success');
      }
      await loadSourcesAndRuns();
    } catch (err) {
      showAlert('Error de red al ejecutar la fuente: ' + err.message, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-play-fill"></i> Ejecutar`;
      }
    }
  }

  async function handleRunAllActive() {
    try {
      const res = await fetch('/api/sources/run-all', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showAlert(data.message, 'info');
        setTimeout(loadSourcesAndRuns, 1500);
      }
    } catch (err) {
      showAlert('Error al iniciar ejecución masiva: ' + err.message, 'danger');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnOpenNewSource')?.addEventListener('click', openSourceEditorForNew);
    document.getElementById('btnCloseSourceEditor')?.addEventListener('click', closeSourceEditor);
    document.getElementById('btnCancelSourceEdit')?.addEventListener('click', closeSourceEditor);
    document.getElementById('sourceEditorForm')?.addEventListener('submit', handleSaveSource);
    document.getElementById('btnRefreshSources')?.addEventListener('click', loadSourcesAndRuns);
    document.getElementById('btnRunAllActive')?.addEventListener('click', handleRunAllActive);

    const reqAuthSwitch = document.getElementById('srcRequiresAuthSwitch');
    const authBox = document.getElementById('srcAuthFieldsBox');
    reqAuthSwitch?.addEventListener('change', () => {
      if (reqAuthSwitch.checked) {
        authBox?.classList.remove('d-none');
      } else {
        authBox?.classList.add('d-none');
      }
    });

    loadSourcesAndRuns();
    // Refresco automático de la tabla y bitácora cada 15 segundos
    setInterval(loadSourcesAndRuns, 15000);
  });
})();
