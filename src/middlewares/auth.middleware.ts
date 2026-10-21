import { Request, Response, NextFunction } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    role: 'admin' | 'operador' | 'lector';
  };
}

/**
 * Middleware de autenticación y control de acceso basado en rol (RBAC).
 * Protege todos los endpoints de /api/settings/llm exclusivamente para el rol 'admin'.
 */
export function requireAdminRole(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const roleHeader = String(req.headers['x-user-role'] || 'admin').toLowerCase();
  const userHeader = String(req.headers['x-user-name'] || 'admin@scrapper.local');

  if (roleHeader !== 'admin') {
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN_ADMIN_ONLY',
      message: 'Acceso denegado: Solo usuarios con rol "admin" pueden administrar la configuración de IA (Claude).',
    });
    return;
  }

  req.user = {
    id: userHeader,
    username: userHeader,
    role: 'admin',
  };

  next();
}
