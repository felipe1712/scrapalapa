/**
 * Controlador de Inicio de Sesión — Scrapper Multitenant
 */
(function () {
  'use strict';

  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('loginEmail');
  const pwdInput = document.getElementById('loginPassword');
  const togglePwdBtn = document.getElementById('btnToggleLoginPwd');
  const submitBtn = document.getElementById('btnSubmitLogin');
  const errorAlert = document.getElementById('loginErrorAlert');

  function showError(msg) {
    if (!errorAlert) return;
    errorAlert.textContent = msg;
    errorAlert.classList.remove('d-none');
  }

  togglePwdBtn?.addEventListener('click', () => {
    if (!pwdInput) return;
    const isPwd = pwdInput.getAttribute('type') === 'password';
    pwdInput.setAttribute('type', isPwd ? 'text' : 'password');
    togglePwdBtn.innerHTML = isPwd ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorAlert?.classList.add('d-none');

    const email = (emailInput?.value || '').trim();
    const password = pwdInput?.value || '';

    if (!email || !password) {
      showError('Ingresa tu correo electrónico y contraseña.');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Verificando acceso...';
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        showError(data.message || 'Credenciales incorrectas.');
        return;
      }

      window.location.href = '/licitaciones.html';
    } catch (err) {
      showError('Error de conexión con el servidor: ' + (err.message || err));
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="bi bi-box-arrow-in-right me-1"></i> Iniciar Sesión';
      }
    }
  });
})();
