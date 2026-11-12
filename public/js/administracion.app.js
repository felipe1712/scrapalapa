/**
 * Scrapper — Administración Multitenant (Clientes, Usuarios y Bitácora de Actividad)
 */
(function () {
  'use strict';

  const state = {
    session: null,
    tenants: [],
    users: [],
    activityLogs: [],
    tenders: [],
  };

  function fmtDateTime(val, fallback = '-') {
    if (!val) return fallback;
    if (window.ScrapperDate?.formatDateTime) return window.ScrapperDate.formatDateTime(val, fallback);
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const TAB_MAP = {
    '#clientes': '#pane-clientes',
    '#usuarios': '#pane-usuarios',
    '#licitaciones': '#pane-licitaciones',
    '#actividad': '#pane-actividad',
  };

  function activateTab(hash, updateUrl = true) {
    const target = TAB_MAP[hash] || '#pane-clientes';
    document.querySelectorAll('#adminTabs .nav-link').forEach((link) => {
      if (link.getAttribute('href') === hash) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });

    document.querySelectorAll('#adminTabsContent .tab-pane').forEach((pane) => {
      if ('#' + pane.id === target) {
        pane.classList.add('show', 'active');
      } else {
        pane.classList.remove('show', 'active');
      }
    });

    if (updateUrl && window.location.hash !== hash) {
      history.replaceState(null, '', hash);
    }

    if (hash === '#licitaciones') {
      loadAdminTenders();
    }
  }

  function showFeedback(message, type = 'success') {
    const el = document.getElementById('adminFeedbackAlert');
    if (!el) return;
    el.className = `alert alert-${type} border-0 shadow-sm mb-3`;
    el.innerHTML = `<div class="d-flex align-items-center justify-content-between">
      <span><i class="bi ${type === 'success' ? 'bi-check-circle-fill' : 'bi-exclamation-triangle-fill'} me-2"></i>${message}</span>
      <button type="button" class="btn-close" onclick="this.parentElement.parentElement.classList.add('d-none')"></button>
    </div>`;
    el.classList.remove('d-none');
  }

  // =========================================================================
  // 1. GESTIÓN DE CLIENTES (TENANTS)
  // =========================================================================
  async function loadTenants() {
    try {
      const res = await fetch('/api/admin/tenants');
      const data = await res.json();
      if (!data.ok) return;

      state.tenants = data.tenants || [];
      populateTenantSelects();
      renderTenantsTable();
    } catch {
      // ignore
    }
  }

  function populateTenantSelects() {
    const isSuperAdmin = state.session?.role === 'superadmin';
    const userTenantSelect = document.getElementById('uTenantIdSelect');
    const filterUsersTenant = document.getElementById('filterUsersByTenant');
    const filterActTenant = document.getElementById('filterActivityByTenant');
    const filterTendersTenant = document.getElementById('filterTendersTenant');

    if (userTenantSelect) {
      userTenantSelect.innerHTML = state.tenants
        .map((t) => `<option value="${t.id}">${t.nombre_comercial} (${t.rfc || 'S/RFC'})</option>`)
        .join('');
      if (!isSuperAdmin && state.session?.activeTenantId) {
        userTenantSelect.value = String(state.session.activeTenantId);
        userTenantSelect.disabled = true;
      } else {
        userTenantSelect.disabled = false;
      }
    }

    const filterOpts =
      `<option value="">Todos los clientes</option>` +
      state.tenants.map((t) => `<option value="${t.id}">${t.nombre_comercial}</option>`).join('');

    if (filterUsersTenant) {
      const prev = filterUsersTenant.value;
      filterUsersTenant.innerHTML = filterOpts;
      filterUsersTenant.value = prev;
      filterUsersTenant.classList.toggle('d-none', !isSuperAdmin);
    }

    if (filterActTenant) {
      const prev = filterActTenant.value;
      filterActTenant.innerHTML = filterOpts;
      filterActTenant.value = prev;
      filterActTenant.classList.toggle('d-none', !isSuperAdmin);
    }

    if (filterTendersTenant) {
      const prev = filterTendersTenant.value;
      filterTendersTenant.innerHTML = filterOpts;
      filterTendersTenant.value = prev;
      filterTendersTenant.parentElement?.classList.toggle('d-none', !isSuperAdmin);
    }
  }

  function renderTenantsTable() {
    const tbody = document.getElementById('tenantsTableBody');
    if (!tbody) return;

    const isSuperAdmin = state.session?.role === 'superadmin';
    const btnNewTenant = document.getElementById('btnNewTenant');
    if (btnNewTenant) btnNewTenant.classList.toggle('d-none', !isSuperAdmin);

    if (state.tenants.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-secondary py-4">No hay clientes registrados.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.tenants
      .map((t) => {
        const direccionStr = [
          t.calle ? `${t.calle} ${t.numero_exterior || ''}`.trim() : '',
          t.colonia ? `Col. ${t.colonia}` : '',
          t.codigo_postal ? `C.P. ${t.codigo_postal}` : '',
          t.ciudad || t.estado ? `${t.ciudad || ''}, ${t.estado || ''}`.replace(/^,\s*|,\s*$/g, '') : '',
        ]
          .filter(Boolean)
          .join('<br>');

        const adminContact = t.contacto_admin_nombre
          ? `<div class="fw-bold text-dark">${t.contacto_admin_nombre}</div>
             <div class="small text-secondary">${t.contacto_admin_cargo || ''}</div>
             <div class="small"><i class="bi bi-envelope me-1"></i>${t.contacto_admin_email || '-'}</div>
             <div class="small"><i class="bi bi-telephone me-1"></i>${t.contacto_admin_telefono || '-'}</div>`
          : '<span class="text-secondary">-</span>';

        const techContact = t.contacto_tecnico_nombre
          ? `<div class="fw-bold text-dark">${t.contacto_tecnico_nombre}</div>
             <div class="small text-secondary">${t.contacto_tecnico_cargo || ''}</div>
             <div class="small"><i class="bi bi-envelope me-1"></i>${t.contacto_tecnico_email || '-'}</div>
             <div class="small"><i class="bi bi-telephone me-1"></i>${t.contacto_tecnico_telefono || '-'}</div>`
          : '<span class="text-secondary">-</span>';

        const statusBadge = t.activo
          ? `<span class="badge bg-success">Activo</span>`
          : `<span class="badge bg-secondary">Suspendido</span>`;

        const deleteBtnHtml =
          isSuperAdmin && Number(t.id) !== 1
            ? `<button type="button" class="btn btn-sm btn-outline-danger btn-delete-tenant ms-1" data-id="${t.id}" title="Eliminar cliente"><i class="bi bi-trash"></i></button>`
            : '';

        return `<tr>
          <td><strong>#${t.id}</strong></td>
          <td>
            <div class="fw-bold text-dark">${t.nombre_comercial}</div>
            <div class="small text-secondary">${t.razon_social || ''}</div>
            <div class="mt-1">
              <span class="badge bg-light text-dark border">RFC: ${t.rfc || 'S/N'}</span>
              ${t.regimen_fiscal ? `<span class="badge bg-light text-secondary border ms-1">${t.regimen_fiscal}</span>` : ''}
            </div>
          </td>
          <td class="small text-secondary">${direccionStr || '-'}</td>
          <td>${adminContact}</td>
          <td>${techContact}</td>
          <td class="text-center"><span class="badge bg-primary-subtle text-primary border">${t.total_usuarios || 0}</span></td>
          <td class="text-center"><span class="badge bg-light text-dark border">${t.total_licitaciones || 0}</span></td>
          <td>${statusBadge}</td>
          <td class="text-end text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-primary btn-edit-tenant" data-id="${t.id}">
              <i class="bi bi-pencil-square me-1"></i> Editar
            </button>
            ${deleteBtnHtml}
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('.btn-edit-tenant').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-id'));
        const tenant = state.tenants.find((x) => Number(x.id) === id);
        if (tenant) openTenantForm(tenant);
      });
    });

    tbody.querySelectorAll('.btn-delete-tenant').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-id'));
        const tenant = state.tenants.find((x) => Number(x.id) === id);
        if (!confirm(`¿Seguro que deseas eliminar al cliente "${tenant?.nombre_comercial}" y todos sus registros?`)) {
          return;
        }
        const res = await fetch(`/api/admin/tenants/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          showFeedback(data.message, 'success');
          await loadTenants();
          await loadUsers();
        } else {
          showFeedback(data.message || 'No se pudo eliminar el cliente.', 'danger');
        }
      });
    });
  }

  function openTenantForm(tenant = null) {
    const card = document.getElementById('tenantFormCard');
    const title = document.getElementById('tenantFormTitle');
    if (!card) return;

    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v ?? '';
    };

    if (tenant) {
      if (title) title.innerHTML = `<i class="bi bi-pencil-square text-primary me-2"></i>Editar Cliente #${tenant.id}: ${tenant.nombre_comercial}`;
      setVal('tenantIdInput', tenant.id);
      setVal('tNombreComercial', tenant.nombre_comercial);
      setVal('tRazonSocial', tenant.razon_social);
      setVal('tRfc', tenant.rfc);
      setVal('tRegimenFiscal', tenant.regimen_fiscal);
      setVal('tUsoCfdi', tenant.uso_cfdi);
      setVal('tEmailFacturacion', tenant.email_facturacion);
      setVal('tCalle', tenant.calle);
      setVal('tNumExterior', tenant.numero_exterior);
      setVal('tNumInterior', tenant.numero_interior);
      setVal('tCodigoPostal', tenant.codigo_postal);
      setVal('tColonia', tenant.colonia);
      setVal('tMunicipio', tenant.municipio_alcaldia);
      setVal('tCiudad', tenant.ciudad);
      setVal('tEstado', tenant.estado);
      setVal('tAdminNombre', tenant.contacto_admin_nombre);
      setVal('tAdminCargo', tenant.contacto_admin_cargo);
      setVal('tAdminEmail', tenant.contacto_admin_email);
      setVal('tAdminTelefono', tenant.contacto_admin_telefono);
      setVal('tTecnicoNombre', tenant.contacto_tecnico_nombre);
      setVal('tTecnicoCargo', tenant.contacto_tecnico_cargo);
      setVal('tTecnicoEmail', tenant.contacto_tecnico_email);
      setVal('tTecnicoTelefono', tenant.contacto_tecnico_telefono);
      setVal('tNotas', tenant.notas);
      const sw = document.getElementById('tActivoSwitch');
      if (sw) sw.checked = Boolean(tenant.activo);
    } else {
      if (title) title.innerHTML = `<i class="bi bi-building-add text-primary me-2"></i>Alta de Nuevo Cliente`;
      document.getElementById('tenantForm')?.reset();
      setVal('tenantIdInput', '');
      const sw = document.getElementById('tActivoSwitch');
      if (sw) sw.checked = true;
    }

    card.classList.remove('d-none');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeTenantForm() {
    document.getElementById('tenantFormCard')?.classList.add('d-none');
  }

  async function handleSaveTenant(e) {
    e.preventDefault();
    const id = document.getElementById('tenantIdInput')?.value;
    const val = (elId) => document.getElementById(elId)?.value?.trim() || '';

    const payload = {
      nombre_comercial: val('tNombreComercial'),
      razon_social: val('tRazonSocial'),
      rfc: val('tRfc').toUpperCase(),
      regimen_fiscal: val('tRegimenFiscal'),
      uso_cfdi: val('tUsoCfdi'),
      email_facturacion: val('tEmailFacturacion'),
      calle: val('tCalle'),
      numero_exterior: val('tNumExterior'),
      numero_interior: val('tNumInterior'),
      codigo_postal: val('tCodigoPostal'),
      colonia: val('tColonia'),
      municipio_alcaldia: val('tMunicipio'),
      ciudad: val('tCiudad'),
      estado: val('tEstado'),
      pais: 'México',
      contacto_admin_nombre: val('tAdminNombre'),
      contacto_admin_cargo: val('tAdminCargo'),
      contacto_admin_email: val('tAdminEmail'),
      contacto_admin_telefono: val('tAdminTelefono'),
      contacto_tecnico_nombre: val('tTecnicoNombre'),
      contacto_tecnico_cargo: val('tTecnicoCargo'),
      contacto_tecnico_email: val('tTecnicoEmail'),
      contacto_tecnico_telefono: val('tTecnicoTelefono'),
      notas: val('tNotas'),
      activo: Boolean(document.getElementById('tActivoSwitch')?.checked),
    };

    try {
      const url = id ? `/api/admin/tenants/${id}` : '/api/admin/tenants';
      const method = id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showFeedback(data.message || 'Error al guardar el cliente.', 'danger');
        return;
      }
      showFeedback(data.message, 'success');
      closeTenantForm();
      await loadTenants();
      await loadActivity();
    } catch (err) {
      showFeedback('Error al guardar cliente: ' + err.message, 'danger');
    }
  }

  // =========================================================================
  // 2. GESTIÓN DE USUARIOS Y PERFILES
  // =========================================================================
  async function loadUsers() {
    try {
      const tenantFilter = document.getElementById('filterUsersByTenant')?.value || '';
      const url = tenantFilter
        ? `/api/admin/users?tenant_id=${encodeURIComponent(tenantFilter)}`
        : '/api/admin/users';
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) return;

      state.users = data.users || [];
      populateActivityUserFilter();
      renderUsersTable();
    } catch {
      // ignore
    }
  }

  function populateActivityUserFilter() {
    const sel = document.getElementById('filterActivityByUser');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML =
      `<option value="">Todos los usuarios</option>` +
      state.users
        .map((u) => `<option value="${u.id}">${u.nombre_completo} (${u.email})</option>`)
        .join('');
    sel.value = prev;
  }

  function renderUsersTable() {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    if (state.users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-4">No hay usuarios registrados para este filtro.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.users
      .map((u) => {
        const roleBadge =
          u.role === 'superadmin'
            ? `<span class="badge bg-danger">Super Administrador</span>`
            : u.role === 'admin'
              ? `<span class="badge bg-primary">Administrador</span>`
              : `<span class="badge bg-secondary">Analista</span>`;

        const statusBadge = u.activo
          ? `<span class="badge bg-success">Activo</span>`
          : `<span class="badge bg-secondary">Inactivo</span>`;

        const lastAccess = u.ultimo_acceso_at
          ? fmtDateTime(u.ultimo_acceso_at, 'Sin ingresos')
          : 'Sin ingresos';

        return `<tr>
          <td><strong>#${u.id}</strong></td>
          <td>
            <div class="fw-bold text-dark">${u.nombre_completo}</div>
            <div class="small text-secondary">${u.cargo || ''}${u.telefono ? ` · ${u.telefono}` : ''}</div>
          </td>
          <td><span class="fw-medium text-primary"><i class="bi bi-envelope me-1"></i>${u.email}</span></td>
          <td><span class="badge bg-light text-dark border"><i class="bi bi-building me-1"></i>${u.tenant_nombre || '-'}</span></td>
          <td>${roleBadge}</td>
          <td class="small text-secondary text-nowrap">${lastAccess}</td>
          <td>${statusBadge}</td>
          <td class="text-end text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-primary btn-edit-user" data-id="${u.id}">
              <i class="bi bi-pencil-square me-1"></i> Editar
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger btn-delete-user ms-1" data-id="${u.id}">
              <i class="bi bi-trash"></i>
            </button>
          </td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('.btn-edit-user').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-id'));
        const user = state.users.find((x) => Number(x.id) === id);
        if (user) openUserForm(user);
      });
    });

    tbody.querySelectorAll('.btn-delete-user').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-id'));
        const user = state.users.find((x) => Number(x.id) === id);
        if (!confirm(`¿Seguro que deseas eliminar al usuario "${user?.email}"?`)) return;
        const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          showFeedback(data.message, 'success');
          await loadUsers();
          await loadTenants();
          await loadActivity();
        } else {
          showFeedback(data.message || 'No se pudo eliminar el usuario.', 'danger');
        }
      });
    });
  }

  function openUserForm(user = null) {
    const card = document.getElementById('userFormCard');
    const title = document.getElementById('userFormTitle');
    const pwdLabel = document.getElementById('uPasswordLabel');
    const pwdInput = document.getElementById('uPasswordInput');
    const superOpt = document.getElementById('optRoleSuperAdmin');

    if (superOpt) {
      superOpt.classList.toggle('d-none', state.session?.role !== 'superadmin');
    }

    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v ?? '';
    };

    if (user) {
      if (title) title.innerHTML = `<i class="bi bi-person-gear text-primary me-2"></i>Editar Usuario: ${user.email}`;
      setVal('userIdInput', user.id);
      setVal('uTenantIdSelect', user.tenant_id);
      setVal('uEmailInput', user.email);
      setVal('uNombreInput', user.nombre_completo);
      setVal('uRoleSelect', user.role);
      setVal('uCargoInput', user.cargo);
      setVal('uTelefonoInput', user.telefono);
      setVal('uPasswordInput', '');
      if (pwdLabel) pwdLabel.textContent = 'Nueva Contraseña (opcional)';
      if (pwdInput) pwdInput.required = false;
      const sw = document.getElementById('uActivoSwitch');
      if (sw) sw.checked = Boolean(user.activo);
    } else {
      if (title) title.innerHTML = `<i class="bi bi-person-plus text-primary me-2"></i>Alta de Nuevo Usuario`;
      document.getElementById('userForm')?.reset();
      setVal('userIdInput', '');
      if (state.session?.activeTenantId) {
        setVal('uTenantIdSelect', state.session.activeTenantId);
      }
      if (pwdLabel) pwdLabel.textContent = 'Contraseña *';
      if (pwdInput) pwdInput.required = true;
      const sw = document.getElementById('uActivoSwitch');
      if (sw) sw.checked = true;
    }

    card?.classList.remove('d-none');
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeUserForm() {
    document.getElementById('userFormCard')?.classList.add('d-none');
  }

  async function handleSaveUser(e) {
    e.preventDefault();
    const id = document.getElementById('userIdInput')?.value;
    const val = (elId) => document.getElementById(elId)?.value?.trim() || '';

    const payload = {
      tenant_id: Number(document.getElementById('uTenantIdSelect')?.value || 1),
      email: val('uEmailInput'),
      nombre_completo: val('uNombreInput'),
      role: val('uRoleSelect') || 'analista',
      password: document.getElementById('uPasswordInput')?.value || undefined,
      cargo: val('uCargoInput'),
      telefono: val('uTelefonoInput'),
      activo: Boolean(document.getElementById('uActivoSwitch')?.checked),
    };

    try {
      const url = id ? `/api/admin/users/${id}` : '/api/admin/users';
      const method = id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showFeedback(data.message || 'Error al guardar el usuario.', 'danger');
        return;
      }
      showFeedback(data.message, 'success');
      closeUserForm();
      await loadUsers();
      await loadTenants();
      await loadActivity();
    } catch (err) {
      showFeedback('Error al guardar usuario: ' + err.message, 'danger');
    }
  }

  // =========================================================================
  // 3. BITÁCORA DE ACTIVIDAD
  // =========================================================================
  async function loadActivity() {
    try {
      const tenantId = document.getElementById('filterActivityByTenant')?.value || '';
      const userId = document.getElementById('filterActivityByUser')?.value || '';
      const params = new URLSearchParams();
      if (tenantId) params.set('tenant_id', tenantId);
      if (userId) params.set('user_id', userId);

      const res = await fetch(`/api/admin/activity?${params.toString()}`);
      const data = await res.json();
      if (!data.ok) return;

      state.activityLogs = data.logs || [];
      renderActivityTable();
    } catch {
      // ignore
    }
  }

  function renderActivityTable() {
    const tbody = document.getElementById('activityTableBody');
    if (!tbody) return;

    if (state.activityLogs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-secondary py-4">Sin registros de actividad para este filtro.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.activityLogs
      .map((a) => {
        return `<tr>
          <td class="text-nowrap">${fmtDateTime(a.created_at)}</td>
          <td><span class="badge bg-light text-dark border">${a.tenant_nombre || `Cliente #${a.tenant_id || 1}`}</span></td>
          <td>
            <div class="fw-bold text-dark">${a.user_nombre || '-'}</div>
            <div class="small text-secondary">${a.user_email || ''}</div>
          </td>
          <td><span class="badge bg-secondary">${a.user_role || '-'}</span></td>
          <td><span class="badge bg-primary-subtle text-primary border">${a.modulo}</span></td>
          <td class="fw-medium text-dark">${a.accion}</td>
          <td class="small text-secondary">${a.detalle || '-'}</td>
        </tr>`;
      })
      .join('');
  }

  // =========================================================================
  // 4. GESTIÓN Y ELIMINACIÓN DE LICITACIONES EN BASE DE DATOS
  // =========================================================================
  let tendersSearchDebounce = null;

  async function loadAdminTenders() {
    try {
      const search = document.getElementById('filterTendersSearch')?.value || '';
      const tenantId = document.getElementById('filterTendersTenant')?.value || '';
      const estado = document.getElementById('filterTendersEstado')?.value || '';
      const origen = document.getElementById('filterTendersOrigen')?.value || '';

      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (tenantId) params.set('tenant_id', tenantId);
      if (estado) params.set('estado', estado);
      if (origen) params.set('origen', origen);

      const res = await fetch(`/api/admin/tenders?${params.toString()}`);
      const data = await res.json();
      if (!data.ok) {
        showFeedback(data.message || 'Error al cargar licitaciones.', 'danger');
        return;
      }

      state.tenders = data.tenders || [];

      // Actualizar tarjetas de métricas
      if (data.metrics) {
        const m = data.metrics;
        const elTotal = document.getElementById('tendersMetricTotal');
        const elComp = document.getElementById('tendersMetricCompletadas');
        const elProcs = document.getElementById('tendersMetricProcs');
        const elDocs = document.getElementById('tendersMetricDocs');

        if (elTotal) elTotal.textContent = String(m.total_tenders || 0);
        if (elComp) elComp.textContent = String(m.completadas || 0);
        if (elProcs) elProcs.textContent = String(m.total_procedimientos || 0);
        if (elDocs) elDocs.textContent = String(m.total_documentos || 0);
      }

      renderAdminTendersTable();
    } catch (err) {
      console.error('Error cargando licitaciones admin:', err);
    }
  }

  function renderAdminTendersTable() {
    const tbody = document.getElementById('adminTendersTableBody');
    if (!tbody) return;

    if (state.tenders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-4">No se encontraron licitaciones con los filtros seleccionados.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.tenders
      .map((t) => {
        let origenBadge = '<span class="badge bg-light text-dark border"><i class="bi bi-globe2 me-1"></i>Web</span>';
        if (t.origen_tipo === 'source') {
          origenBadge = `<span class="badge bg-primary-subtle text-primary border" title="${escapeHtml(t.source_nombre || '')}"><i class="bi bi-broadcast me-1"></i>Fuente</span>`;
        } else if (t.origen_tipo === 'email') {
          origenBadge = `<span class="badge bg-warning-subtle text-warning-emphasis border" title="${escapeHtml(t.source_nombre || '')}"><i class="bi bi-envelope me-1"></i>Correo E</span>`;
        }

        let estadoBadge = '<span class="badge bg-secondary">Pendiente</span>';
        if (t.estado === 'completado') {
          estadoBadge = '<span class="badge bg-success">Completado</span>';
        } else if (t.estado === 'error') {
          estadoBadge = '<span class="badge bg-danger">Error</span>';
        } else if (t.estado === 'procesando') {
          estadoBadge = '<span class="badge bg-warning text-dark">Procesando</span>';
        }

        const expCode = t.numero_expediente || `ID-${t.id}`;
        const dateStr = fmtDateTime(t.created_at, '-');

        return `<tr>
          <td>
            <span class="badge bg-primary mb-1">#${t.id}</span>
            <div class="small fw-semibold text-dark text-truncate" style="max-width: 140px;" title="${escapeHtml(expCode)}">${escapeHtml(expCode)}</div>
          </td>
          <td>
            <div class="fw-bold text-dark text-truncate" style="max-width: 320px;" title="${escapeHtml(t.titulo || t.source_url)}">
              ${escapeHtml(t.titulo || 'Sin título registrado')}
            </div>
            <div class="text-secondary small text-truncate" style="max-width: 320px;">
              <i class="bi bi-building me-1"></i>${escapeHtml(t.entidad || 'Entidad no especificada')}
            </div>
            <div class="mt-1">
              <a href="${escapeHtml(t.source_url || '#')}" target="_blank" class="small text-muted text-truncate d-inline-block align-bottom" style="max-width: 280px;">
                <i class="bi bi-link-45deg me-1"></i>${escapeHtml(t.source_url || '-')}
              </a>
            </div>
          </td>
          <td>
            <span class="badge bg-light text-dark border">${escapeHtml(t.tenant_nombre || `Cliente #${t.tenant_id || 1}`)}</span>
          </td>
          <td>${origenBadge}</td>
          <td class="text-center text-nowrap">
            <span class="badge bg-primary-subtle text-primary border me-1">${t.total_procedimientos || 0} procs</span>
            <span class="badge bg-light text-secondary border">${t.total_documentos || 0} docs</span>
          </td>
          <td class="text-center">${estadoBadge}</td>
          <td class="text-nowrap small text-secondary">${dateStr}</td>
          <td class="text-end text-nowrap">
            <a href="licitaciones.html#proc-${t.id}" class="btn btn-sm btn-outline-primary me-1" title="Abrir en Pipeline / Visor" target="_blank">
              <i class="bi bi-box-arrow-up-right"></i>
            </a>
            <button type="button" class="btn btn-sm btn-outline-danger btn-delete-tender" data-id="${t.id}" data-title="${escapeHtml(t.titulo || t.source_url)}" data-exp="${escapeHtml(expCode)}" data-docs="${t.total_documentos || 0}" data-procs="${t.total_procedimientos || 0}" data-bs-toggle="modal" data-bs-target="#deleteTenderConfirmModal" data-toggle="modal" data-target="#deleteTenderConfirmModal" title="Eliminar licitación y todos sus archivos asociados">
              <i class="bi bi-trash3"></i>
            </button>
          </td>
        </tr>`;
      })
      .join('');

    // Conectar eventos directos de eliminación
    tbody.querySelectorAll('.btn-delete-tender').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const tid = btn.getAttribute('data-id');
        const title = btn.getAttribute('data-title');
        const exp = btn.getAttribute('data-exp');
        const docs = btn.getAttribute('data-docs');
        const procs = btn.getAttribute('data-procs');
        openDeleteTenderModal(tid, title, exp, docs, procs);
      });
    });
  }

  function setDeleteModalFields(tenderId, title, exp, docs, procs) {
    const inputId = document.getElementById('deleteTenderId');
    const nameEl = document.getElementById('deleteTenderName');
    const infoEl = document.getElementById('deleteTenderInfo');

    if (inputId) inputId.value = tenderId;
    if (nameEl) nameEl.textContent = `Licitación #${tenderId}: ${title || 'Sin título'}`;
    if (infoEl) infoEl.textContent = `Expediente: ${exp || '-'} | Sub-procedimientos: ${procs || 0} | Archivos / Documentos: ${docs || 0}`;
  }

  function openDeleteTenderModal(tenderId, title, exp, docs, procs) {
    setDeleteModalFields(tenderId, title, exp, docs, procs);

    const modalEl = document.getElementById('deleteTenderConfirmModal');
    let modalShown = false;

    // 1. Intentar con Bootstrap 5 JS API
    if (window.bootstrap?.Modal && modalEl) {
      try {
        const modalInstance = window.bootstrap.Modal.getOrCreateInstance(modalEl);
        modalInstance.show();
        modalShown = true;
      } catch (err) {
        console.warn('Aviso: bootstrap.Modal falló:', err);
      }
    }

    // 2. Intentar con jQuery Bootstrap plugin
    if (!modalShown && window.$ && modalEl && typeof window.$(modalEl).modal === 'function') {
      try {
        window.$(modalEl).modal('show');
        modalShown = true;
      } catch (err) {
        console.warn('Aviso: jQuery modal falló:', err);
      }
    }

    // 3. Fallback directo nativo: si por librerías JS no abrió el modal visual,
    // mostrar confirm() nativo del navegador inmediatamente para nunca dejar bloqueado al usuario
    if (!modalShown) {
      const confirmDelete = window.confirm(
        `¿Confirmas la eliminación permanente de la licitación #${tenderId} (${title || 'Sin título'})?\n\n` +
        `Esta acción borrará irreversiblemente el expediente, sus sub-procedimientos, cronogramas y todos sus documentos físicos de la base de datos.`
      );
      if (confirmDelete) {
        executeDeleteTender(tenderId);
      }
    }
  }

  async function executeDeleteTender(tenderId) {
    if (!tenderId) return;

    const btn = document.getElementById('btnConfirmDeleteTender');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span>Eliminando registros y archivos...';
    }

    try {
      const res = await fetch(`/api/admin/tenders/${tenderId}`, {
        method: 'DELETE',
      });
      const data = await res.json();

      if (!data.ok) {
        showFeedback(data.message || 'Error al eliminar la licitación.', 'danger');
        return;
      }

      // Cerrar modal si estuviera abierto
      const modalEl = document.getElementById('deleteTenderConfirmModal');
      if (window.bootstrap?.Modal && modalEl) {
        try {
          window.bootstrap.Modal.getInstance(modalEl)?.hide();
        } catch {}
      }
      if (window.$ && modalEl && typeof window.$(modalEl).modal === 'function') {
        try {
          window.$(modalEl).modal('hide');
        } catch {}
      }

      showFeedback(`¡Licitación #${tenderId} y todos sus registros y archivos vinculados han sido eliminados de la base de datos!`, 'success');

      // Recargar tabla de licitaciones, clientes y bitácora
      await loadAdminTenders();
      await loadTenants();
      await loadActivity();
    } catch (err) {
      showFeedback(`Error al procesar la eliminación: ${err.message}`, 'danger');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  }

  async function handleConfirmDeleteTender() {
    const inputId = document.getElementById('deleteTenderId');
    const tenderId = inputId?.value;
    if (!tenderId) return;
    await executeDeleteTender(tenderId);
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('#adminTabs .nav-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        activateTab(link.getAttribute('href') || '#clientes');
      });
    });

    if (window.location.hash && TAB_MAP[window.location.hash]) {
      activateTab(window.location.hash, false);
    }

    document.getElementById('btnNewTenant')?.addEventListener('click', () => openTenantForm(null));
    document.getElementById('btnCloseTenantForm')?.addEventListener('click', closeTenantForm);
    document.getElementById('btnCancelTenantForm')?.addEventListener('click', closeTenantForm);
    document.getElementById('tenantForm')?.addEventListener('submit', handleSaveTenant);
    document.getElementById('btnRefreshTenants')?.addEventListener('click', loadTenants);

    document.getElementById('btnNewUser')?.addEventListener('click', () => openUserForm(null));
    document.getElementById('btnCloseUserForm')?.addEventListener('click', closeUserForm);
    document.getElementById('btnCancelUserForm')?.addEventListener('click', closeUserForm);
    document.getElementById('userForm')?.addEventListener('submit', handleSaveUser);
    document.getElementById('btnRefreshUsers')?.addEventListener('click', loadUsers);
    document.getElementById('filterUsersByTenant')?.addEventListener('change', loadUsers);

    document.getElementById('btnRefreshActivity')?.addEventListener('click', loadActivity);
    document.getElementById('filterActivityByTenant')?.addEventListener('change', loadActivity);
    document.getElementById('filterActivityByUser')?.addEventListener('change', loadActivity);

    // Eventos de Pestaña Licitaciones
    document.getElementById('btnRefreshAdminTenders')?.addEventListener('click', loadAdminTenders);
    document.getElementById('filterTendersTenant')?.addEventListener('change', loadAdminTenders);
    document.getElementById('filterTendersEstado')?.addEventListener('change', loadAdminTenders);
    document.getElementById('filterTendersOrigen')?.addEventListener('change', loadAdminTenders);
    document.getElementById('filterTendersSearch')?.addEventListener('input', (e) => {
      clearTimeout(tendersSearchDebounce);
      tendersSearchDebounce = setTimeout(() => {
        loadAdminTenders();
      }, 300);
    });
    document.getElementById('btnConfirmDeleteTender')?.addEventListener('click', handleConfirmDeleteTender);

    // Listener nativo de Bootstrap 5 para sincronizar campos si el modal se abre vía data-bs-toggle
    const deleteModalEl = document.getElementById('deleteTenderConfirmModal');
    if (deleteModalEl) {
      deleteModalEl.addEventListener('show.bs.modal', (event) => {
        const button = event.relatedTarget;
        if (!button) return;
        const tid = button.getAttribute('data-id');
        const title = button.getAttribute('data-title');
        const exp = button.getAttribute('data-exp');
        const docs = button.getAttribute('data-docs');
        const procs = button.getAttribute('data-procs');
        if (tid) {
          setDeleteModalFields(tid, title, exp, docs, procs);
        }
      });
    }

    // Delegación de clics sobre el cuerpo de la tabla para atrapar clics en botones o sus íconos
    document.getElementById('adminTendersTableBody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-delete-tender');
      if (btn) {
        const tid = btn.getAttribute('data-id');
        const title = btn.getAttribute('data-title');
        const exp = btn.getAttribute('data-exp');
        const docs = btn.getAttribute('data-docs');
        const procs = btn.getAttribute('data-procs');
        openDeleteTenderModal(tid, title, exp, docs, procs);
      }
    });

    window.addEventListener('scrapper:session-ready', (ev) => {
      state.session = ev.detail?.session || null;
      loadTenants();
      loadUsers();
      loadActivity();
      loadAdminTenders();
    });

    if (window.ScrapperSession?.session) {
      state.session = window.ScrapperSession.session;
      loadTenants();
      loadUsers();
      loadActivity();
      loadAdminTenders();
    } else {
      loadTenants();
      loadUsers();
      loadActivity();
      loadAdminTenders();
    }
  });
})();
