/**
 * Gestión Global de Sesión, Selector de Cliente (Multitenant) y Menú por Perfil
 */
(function () {
  'use strict';

  function formatDate(val, fallback = '-') {
    if (!val) return fallback;
    const d = val instanceof Date ? val : new Date(val);
    if (isNaN(d.getTime())) return String(val);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function formatDateTime(val, fallback = '-') {
    if (!val) return fallback;
    const d = val instanceof Date ? val : new Date(val);
    if (isNaN(d.getTime())) return String(val);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  }

  window.ScrapperDate = { formatDate, formatDateTime };

  const ROLE_LABELS = {
    superadmin: 'Super Administrador',
    admin: 'Administrador',
    analista: 'Analista',
  };

  async function initSession() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const data = await res.json();
      if (!data.ok || !data.session) {
        window.location.href = '/login.html';
        return;
      }

      const session = data.session;
      const availableTenants = data.available_tenants || [];
      window.ScrapperSession = {
        session,
        availableTenants,
      };

      renderSidebarMenuByRole(session);
      renderHeaderSessionControls(session, availableTenants);

      window.dispatchEvent(
        new CustomEvent('scrapper:session-ready', {
          detail: { session, availableTenants },
        })
      );
    } catch {
      // ignore network hiccup
    }
  }

  function renderSidebarMenuByRole(session) {
    const navList = document.querySelector('.sidebar .nav.nav-pills');
    if (!navList) return;

    const currentPage = window.location.pathname.split('/').pop() || 'licitaciones.html';

    // Si es analista, ocultar Configuración
    if (session.role === 'analista') {
      const configLink = navList.querySelector('a[href="settings-llm.html"]');
      if (configLink && configLink.parentElement) {
        configLink.parentElement.classList.add('d-none');
      }
    }

    // Mostrar opción "Administración" para superadmin y admin de cliente
    let adminLink = navList.querySelector('a[href="administracion.html"]');
    if (session.role === 'superadmin' || session.role === 'admin') {
      if (!adminLink) {
        const li = document.createElement('li');
        li.className = 'nav-item';
        const isActive = currentPage === 'administracion.html' ? 'active' : '';
        li.innerHTML = `
          <a class="nav-link ${isActive}" href="administracion.html">
            <div class="avatar avatar-40 icon"><i class="bi bi-building-gear bi-people"></i></div>
            <div class="col">Administración</div>
            <div class="arrow"><i class="bi bi-chevron-right"></i></div>
          </a>
        `;
        navList.appendChild(li);
      }
    } else if (adminLink && adminLink.parentElement) {
      adminLink.parentElement.remove();
    }
  }

  function renderHeaderSessionControls(session, availableTenants) {
    const navbarContainer = document.querySelector('header.header nav.navbar .container-fluid');
    if (!navbarContainer) return;

    // Buscar el contenedor derecho del header
    const rightArea = navbarContainer.lastElementChild;
    if (!rightArea) return;

    const roleLabel = ROLE_LABELS[session.role] || session.role;
    const roleBadgeClass =
      session.role === 'superadmin'
        ? 'bg-danger'
        : session.role === 'admin'
          ? 'bg-primary'
          : 'bg-secondary';

    let tenantSelectorHtml = `
      <span class="badge bg-light text-dark border me-3 d-none d-md-inline-block px-3 py-2" title="Cliente Activo">
        ${session.activeTenantName}
      </span>
    `;

    if (session.role === 'superadmin' && availableTenants.length > 0) {
      const optionsHtml = availableTenants
        .map(
          (t) =>
            `<option value="${t.id}" ${
              Number(t.id) === Number(session.activeTenantId) ? 'selected' : ''
            }>${t.nombre_comercial}${!t.activo ? ' (Suspendido)' : ''}</option>`
        )
        .join('');

      tenantSelectorHtml = `
        <div class="d-none d-md-flex align-items-center me-3">
          <select id="headerTenantSelect" class="form-select form-select-sm fw-semibold border-primary" style="min-width: 280px; max-width: 440px;" title="Cliente Activo">
            ${optionsHtml}
          </select>
        </div>
      `;
    }

    rightArea.className = 'col-auto ms-auto d-flex align-items-center';
    rightArea.innerHTML = `
      ${tenantSelectorHtml}
      <div class="d-flex align-items-center me-3" title="${roleLabel} · ${session.email}">
        <figure class="avatar avatar-36 rounded-circle coverimg vm me-2 mb-0">
          <img src="assets/img/user-1.jpg" alt="" />
        </figure>
        <span class="d-none d-sm-inline text-dark fw-semibold small">${session.nombreCompleto}</span>
      </div>
      <button type="button" id="btnHeaderLogout" class="btn btn-sm btn-outline-danger" title="Cerrar Sesión">
        <i class="bi bi-box-arrow-right me-1"></i><span class="d-none d-md-inline">Salir</span>
      </button>
    `;

    const tenantSelect = document.getElementById('headerTenantSelect');
    tenantSelect?.addEventListener('change', async () => {
      const targetId = Number(tenantSelect.value);
      if (!targetId) return;
      tenantSelect.disabled = true;
      try {
        const res = await fetch('/api/auth/switch-tenant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenant_id: targetId }),
        });
        const data = await res.json();
        if (data.ok) {
          window.location.reload();
        } else {
          alert(data.message || 'No se pudo cambiar de cliente.');
          tenantSelect.disabled = false;
        }
      } catch {
        tenantSelect.disabled = false;
      }
    });

    const logoutBtn = document.getElementById('btnHeaderLogout');
    logoutBtn?.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      window.location.href = '/login.html';
    });
  }

  document.addEventListener('DOMContentLoaded', initSession);
})();
