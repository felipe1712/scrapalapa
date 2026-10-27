import { Router } from 'express';
import { z } from 'zod';
import { authService, extractTokenFromRequest } from './auth.service.js';
import { requireAuth } from './auth.middleware.js';
import { db } from '../../db/pool.js';

export const authRouter = Router();

const LoginSchema = z.object({
  email: z.string().email('Ingresa un correo electrónico válido.'),
  password: z.string().min(1, 'Ingresa tu contraseña.'),
});

/**
 * POST /api/auth/login
 * Inicia sesión con correo electrónico y contraseña, emite cookie HttpOnly y devuelve token + sesión.
 */
authRouter.post('/login', async (req, res) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        message: parsed.error.issues[0]?.message || 'Datos de inicio de sesión inválidos.',
      });
      return;
    }

    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '';
    const userAgent = req.headers['user-agent'] || '';

    const { token, session } = await authService.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ipAddress,
      userAgent,
    });

    const maxAgeSec = 7 * 24 * 60 * 60;
    res.setHeader(
      'Set-Cookie',
      `scrapper_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
    );

    res.json({
      ok: true,
      token,
      session,
      message: `Bienvenido(a), ${session.nombreCompleto}`,
    });
  } catch (err: any) {
    res.status(401).json({
      ok: false,
      message: err?.message || 'Error al iniciar sesión.',
    });
  }
});

/**
 * POST /api/auth/logout
 * Cierra la sesión actual y limpia la cookie.
 */
authRouter.post('/logout', async (req, res) => {
  try {
    const token = extractTokenFromRequest(req);
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '';
    await authService.logout(token, req.auth, ipAddress);

    res.setHeader('Set-Cookie', 'scrapper_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true, message: 'Sesión cerrada correctamente.' });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al cerrar sesión.' });
  }
});

/**
 * GET /api/auth/me
 * Devuelve el estado de sesión actual y, si es superadmin, el listado de clientes disponibles para cambiar de contexto.
 */
authRouter.get('/me', requireAuth, async (req, res) => {
  try {
    let availableTenants: Array<{ id: number; nombre_comercial: string; rfc: string; activo: boolean }> = [];
    if (req.auth?.role === 'superadmin') {
      const tRes = await db.query(
        'SELECT id, nombre_comercial, rfc, activo FROM tenants ORDER BY id ASC'
      );
      availableTenants = tRes.rows;
    }

    res.json({
      ok: true,
      session: req.auth,
      available_tenants: availableTenants,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al obtener sesión.' });
  }
});

/**
 * POST /api/auth/switch-tenant
 * Permite al Super Administrador cambiar el cliente activo en su sesión.
 */
authRouter.post('/switch-tenant', requireAuth, async (req, res) => {
  try {
    const token = extractTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ ok: false, message: 'Token de sesión no encontrado.' });
      return;
    }

    const tenantId = Number(req.body?.tenant_id);
    if (!tenantId || Number.isNaN(tenantId)) {
      res.status(400).json({ ok: false, message: 'ID de cliente inválido.' });
      return;
    }

    const updatedSession = await authService.switchActiveTenant(token, tenantId);
    res.json({
      ok: true,
      session: updatedSession,
      message: `Contexto cambiado al cliente: ${updatedSession.activeTenantName}`,
    });
  } catch (err: any) {
    res.status(403).json({ ok: false, message: err?.message || 'No se pudo cambiar de cliente.' });
  }
});
