import crypto from 'node:crypto';
import { Request } from 'express';
import { db } from '../../db/pool.js';

export type UserRole = 'superadmin' | 'admin' | 'analista';

export interface SessionContext {
  sessionId: number;
  userId: number;
  email: string;
  nombreCompleto: string;
  cargo: string;
  role: UserRole;
  homeTenantId: number;
  homeTenantName: string;
  activeTenantId: number;
  activeTenantName: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: SessionContext;
    }
  }
}

export function hashPassword(plainPassword: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

export function verifyPassword(plainPassword: string, storedHash: string): boolean {
  try {
    const parts = (storedHash || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, originalHex] = parts;
    const derived = crypto.scryptSync(plainPassword, salt, 64);
    const original = Buffer.from(originalHex, 'hex');
    if (derived.length !== original.length) return false;
    return crypto.timingSafeEqual(derived, original);
  } catch {
    return false;
  }
}

export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    for (const c of cookies) {
      if (c.startsWith('scrapper_session=')) {
        const val = decodeURIComponent(c.slice('scrapper_session='.length).trim());
        if (val) return val;
      }
    }
  }

  return null;
}

export class AuthService {
  /**
   * Garantiza que exista el Super Administrador inicial:
   * Correo: admin@causer.com.mx | Contraseña inicial: Admin1234!
   */
  async ensureInitialSuperAdmin(): Promise<void> {
    const email = 'admin@causer.com.mx';
    const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
    if ((existing.rowCount ?? 0) === 0) {
      const pwdHash = hashPassword(process.env.INITIAL_SUPERADMIN_PASSWORD || 'Admin1234!');
      await db.query(
        `INSERT INTO users (
          tenant_id, email, nombre_completo, cargo, telefono, password_hash, role, activo
        ) VALUES (1, $1, $2, $3, $4, $5, 'superadmin', TRUE)`,
        [email, 'Super Administrador CAUSER', 'Super Administrador Global', '', pwdHash]
      );
      console.log('[Auth] Usuario Super Administrador inicial creado: admin@causer.com.mx');
    }
  }

  async logActivity(params: {
    tenantId?: number | null;
    userId?: number | null;
    userEmail?: string;
    userNombre?: string;
    userRole?: string;
    accion: string;
    modulo: string;
    detalle?: string;
    ipAddress?: string;
  }): Promise<void> {
    try {
      await db.query(
        `INSERT INTO activity_logs (
          tenant_id, user_id, user_email, user_nombre, user_role, accion, modulo, detalle, ip_address
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          params.tenantId ?? 1,
          params.userId ?? null,
          params.userEmail || '',
          params.userNombre || '',
          params.userRole || '',
          params.accion,
          params.modulo,
          params.detalle || '',
          params.ipAddress || null,
        ]
      );
    } catch (err: any) {
      console.warn('[ActivityLog] Error al guardar bitácora:', err?.message);
    }
  }

  async login(params: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ token: string; session: SessionContext }> {
    const normalizedEmail = params.email.trim().toLowerCase();

    const userRes = await db.query(
      `SELECT
        u.id, u.tenant_id, u.email, u.nombre_completo, u.cargo, u.password_hash, u.role, u.activo,
        t.nombre_comercial AS tenant_nombre, t.activo AS tenant_activo
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE LOWER(u.email) = $1
       LIMIT 1`,
      [normalizedEmail]
    );

    if ((userRes.rowCount ?? 0) === 0) {
      throw new Error('Correo electrónico o contraseña incorrectos.');
    }

    const user = userRes.rows[0];
    if (!verifyPassword(params.password, user.password_hash)) {
      await this.logActivity({
        tenantId: user.tenant_id,
        userId: user.id,
        userEmail: user.email,
        userNombre: user.nombre_completo,
        userRole: user.role,
        accion: 'Intento de login fallido (contraseña inválida)',
        modulo: 'Autenticación',
        ipAddress: params.ipAddress,
      });
      throw new Error('Correo electrónico o contraseña incorrectos.');
    }

    if (!user.activo) {
      throw new Error('Tu cuenta de usuario está desactivada. Contacta al administrador.');
    }

    if (!user.tenant_activo && user.role !== 'superadmin') {
      throw new Error('La cuenta del cliente asociado se encuentra suspendida.');
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 días

    const sessInsert = await db.query(
      `INSERT INTO user_sessions (
        token_hash, user_id, active_tenant_id, ip_address, user_agent, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id`,
      [
        tokenHash,
        user.id,
        user.tenant_id,
        params.ipAddress || null,
        params.userAgent || null,
        expiresAt.toISOString(),
      ]
    );

    await db.query('UPDATE users SET ultimo_acceso_at = NOW() WHERE id = $1', [user.id]);

    const session: SessionContext = {
      sessionId: sessInsert.rows[0].id,
      userId: user.id,
      email: user.email,
      nombreCompleto: user.nombre_completo,
      cargo: user.cargo || '',
      role: user.role as UserRole,
      homeTenantId: user.tenant_id,
      homeTenantName: user.tenant_nombre,
      activeTenantId: user.tenant_id,
      activeTenantName: user.tenant_nombre,
    };

    await this.logActivity({
      tenantId: user.tenant_id,
      userId: user.id,
      userEmail: user.email,
      userNombre: user.nombre_completo,
      userRole: user.role,
      accion: 'Inicio de sesión exitoso',
      modulo: 'Autenticación',
      detalle: `Ingreso al cliente "${user.tenant_nombre}" con perfil ${user.role}`,
      ipAddress: params.ipAddress,
    });

    return { token: rawToken, session };
  }

  async getSessionFromToken(rawToken: string | null): Promise<SessionContext | null> {
    if (!rawToken) return null;
    const tokenHash = hashSessionToken(rawToken);

    const res = await db.query(
      `SELECT
        s.id AS session_id,
        s.active_tenant_id,
        u.id AS user_id,
        u.email,
        u.nombre_completo,
        u.cargo,
        u.role,
        u.activo AS user_activo,
        u.tenant_id AS home_tenant_id,
        ht.nombre_comercial AS home_tenant_name,
        ht.activo AS home_tenant_activo,
        at.nombre_comercial AS active_tenant_name
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN tenants ht ON ht.id = u.tenant_id
       JOIN tenants at ON at.id = s.active_tenant_id
       WHERE s.token_hash = $1
         AND s.expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );

    if ((res.rowCount ?? 0) === 0) return null;
    const row = res.rows[0];
    if (!row.user_activo) return null;
    if (!row.home_tenant_activo && row.role !== 'superadmin') return null;

    return {
      sessionId: row.session_id,
      userId: row.user_id,
      email: row.email,
      nombreCompleto: row.nombre_completo,
      cargo: row.cargo || '',
      role: row.role as UserRole,
      homeTenantId: row.home_tenant_id,
      homeTenantName: row.home_tenant_name,
      activeTenantId: row.active_tenant_id,
      activeTenantName: row.active_tenant_name,
    };
  }

  async logout(rawToken: string | null, session?: SessionContext | null, ipAddress?: string): Promise<void> {
    if (!rawToken) return;
    const tokenHash = hashSessionToken(rawToken);
    await db.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash]);
    if (session) {
      await this.logActivity({
        tenantId: session.activeTenantId,
        userId: session.userId,
        userEmail: session.email,
        userNombre: session.nombreCompleto,
        userRole: session.role,
        accion: 'Cierre de sesión',
        modulo: 'Autenticación',
        ipAddress,
      });
    }
  }

  async switchActiveTenant(rawToken: string, targetTenantId: number): Promise<SessionContext> {
    const current = await this.getSessionFromToken(rawToken);
    if (!current) {
      throw new Error('Sesión inválida o expirada.');
    }
    if (current.role !== 'superadmin') {
      throw new Error('Solo el Super Administrador puede cambiar de cliente activo.');
    }

    const tRes = await db.query('SELECT id, nombre_comercial FROM tenants WHERE id = $1 LIMIT 1', [
      targetTenantId,
    ]);
    if ((tRes.rowCount ?? 0) === 0) {
      throw new Error('El cliente seleccionado no existe.');
    }

    const tokenHash = hashSessionToken(rawToken);
    await db.query('UPDATE user_sessions SET active_tenant_id = $1 WHERE token_hash = $2', [
      targetTenantId,
      tokenHash,
    ]);

    await this.logActivity({
      tenantId: targetTenantId,
      userId: current.userId,
      userEmail: current.email,
      userNombre: current.nombreCompleto,
      userRole: current.role,
      accion: 'Cambio de contexto de cliente',
      modulo: 'Administración',
      detalle: `Cambió vista activa al cliente #${targetTenantId} (${tRes.rows[0].nombre_comercial})`,
    });

    const updated = await this.getSessionFromToken(rawToken);
    if (!updated) throw new Error('Error al actualizar la sesión.');
    return updated;
  }
}

export const authService = new AuthService();
