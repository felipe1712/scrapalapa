import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { requireRoles } from '../auth/auth.middleware.js';
import { authService, hashPassword } from '../auth/auth.service.js';

export const adminRouter = Router();

// Todas las rutas de administración exigen perfil 'superadmin' o 'admin'
adminRouter.use(requireRoles(['superadmin', 'admin']));

const TenantSchema = z.object({
  nombre_comercial: z.string().min(2, 'El nombre comercial es obligatorio.').max(200),
  razon_social: z.string().max(250).optional().default(''),
  rfc: z.string().max(25).optional().default(''),
  regimen_fiscal: z.string().max(120).optional().default(''),
  uso_cfdi: z.string().max(120).optional().default(''),
  email_facturacion: z.string().max(180).optional().default(''),
  // Dirección
  calle: z.string().max(200).optional().default(''),
  numero_exterior: z.string().max(50).optional().default(''),
  numero_interior: z.string().max(50).optional().default(''),
  colonia: z.string().max(150).optional().default(''),
  codigo_postal: z.string().max(20).optional().default(''),
  municipio_alcaldia: z.string().max(150).optional().default(''),
  ciudad: z.string().max(150).optional().default(''),
  estado: z.string().max(120).optional().default(''),
  pais: z.string().max(100).optional().default('México'),
  // Contacto Administrativo
  contacto_admin_nombre: z.string().max(180).optional().default(''),
  contacto_admin_cargo: z.string().max(120).optional().default(''),
  contacto_admin_email: z.string().max(180).optional().default(''),
  contacto_admin_telefono: z.string().max(60).optional().default(''),
  // Contacto Técnico
  contacto_tecnico_nombre: z.string().max(180).optional().default(''),
  contacto_tecnico_cargo: z.string().max(120).optional().default(''),
  contacto_tecnico_email: z.string().max(180).optional().default(''),
  contacto_tecnico_telefono: z.string().max(60).optional().default(''),
  activo: z.boolean().optional().default(true),
  notas: z.string().optional().default(''),
});

const UserCreateSchema = z.object({
  tenant_id: z.coerce.number().int().positive().optional(),
  email: z.string().email('El correo electrónico no es válido.').max(180),
  nombre_completo: z.string().min(2, 'El nombre completo es obligatorio.').max(180),
  cargo: z.string().max(120).optional().default(''),
  telefono: z.string().max(60).optional().default(''),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.'),
  role: z.enum(['superadmin', 'admin', 'analista']).default('analista'),
  activo: z.boolean().optional().default(true),
});

const UserUpdateSchema = z.object({
  tenant_id: z.coerce.number().int().positive().optional(),
  email: z.string().email('El correo electrónico no es válido.').max(180).optional(),
  nombre_completo: z.string().min(2).max(180).optional(),
  cargo: z.string().max(120).optional(),
  telefono: z.string().max(60).optional(),
  password: z.string().optional(),
  role: z.enum(['superadmin', 'admin', 'analista']).optional(),
  activo: z.boolean().optional(),
});

/**
 * GET /api/admin/tenants
 * Lista los clientes registrados con métricas de usuarios, licitaciones y fuentes.
 */
adminRouter.get('/tenants', async (req, res) => {
  try {
    const auth = req.auth!;
    const params: any[] = [];
    let whereSql = '';

    if (auth.role !== 'superadmin') {
      params.push(auth.activeTenantId);
      whereSql = 'WHERE t.id = $1';
    }

    const result = await db.query(
      `SELECT
        t.*,
        (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS total_usuarios,
        (SELECT COUNT(*)::int FROM tenders td WHERE td.tenant_id = t.id) AS total_licitaciones,
        (SELECT COUNT(*)::int FROM scraping_sources s WHERE s.tenant_id = t.id AND s.activo = TRUE) AS fuentes_activas,
        (SELECT COUNT(*)::int FROM email_accounts e WHERE e.tenant_id = t.id AND e.activo = TRUE) AS correos_activos
       FROM tenants t
       ${whereSql}
       ORDER BY t.id ASC`,
      params
    );

    res.json({
      ok: true,
      tenants: result.rows,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al listar clientes.' });
  }
});

/**
 * POST /api/admin/tenants
 * Alta de nuevo cliente con datos fiscales, dirección y contactos administrativo y técnico (Solo SuperAdmin).
 */
adminRouter.post('/tenants', async (req, res) => {
  try {
    const auth = req.auth!;
    if (auth.role !== 'superadmin') {
      res.status(403).json({
        ok: false,
        message: 'Solo el Super Administrador puede dar de alta nuevos clientes.',
      });
      return;
    }

    const parsed = TenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        message: parsed.error.issues[0]?.message || 'Datos del cliente inválidos.',
      });
      return;
    }

    const d = parsed.data;
    const insertRes = await db.query(
      `INSERT INTO tenants (
        nombre_comercial, razon_social, rfc, regimen_fiscal, uso_cfdi, email_facturacion,
        calle, numero_exterior, numero_interior, colonia, codigo_postal, municipio_alcaldia, ciudad, estado, pais,
        contacto_admin_nombre, contacto_admin_cargo, contacto_admin_email, contacto_admin_telefono,
        contacto_tecnico_nombre, contacto_tecnico_cargo, contacto_tecnico_email, contacto_tecnico_telefono,
        activo, notas
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25
      ) RETURNING *`,
      [
        d.nombre_comercial.trim(),
        d.razon_social.trim(),
        d.rfc.trim().toUpperCase(),
        d.regimen_fiscal.trim(),
        d.uso_cfdi.trim(),
        d.email_facturacion.trim().toLowerCase(),
        d.calle.trim(),
        d.numero_exterior.trim(),
        d.numero_interior.trim(),
        d.colonia.trim(),
        d.codigo_postal.trim(),
        d.municipio_alcaldia.trim(),
        d.ciudad.trim(),
        d.estado.trim(),
        d.pais.trim() || 'México',
        d.contacto_admin_nombre.trim(),
        d.contacto_admin_cargo.trim(),
        d.contacto_admin_email.trim().toLowerCase(),
        d.contacto_admin_telefono.trim(),
        d.contacto_tecnico_nombre.trim(),
        d.contacto_tecnico_cargo.trim(),
        d.contacto_tecnico_email.trim().toLowerCase(),
        d.contacto_tecnico_telefono.trim(),
        d.activo,
        d.notas.trim(),
      ]
    );

    const newTenant = insertRes.rows[0];

    await authService.logActivity({
      tenantId: newTenant.id,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Alta de nuevo cliente',
      modulo: 'Administración > Clientes',
      detalle: `Cliente creado: "${newTenant.nombre_comercial}" (RFC: ${newTenant.rfc || 'S/N'})`,
    });

    res.status(201).json({
      ok: true,
      tenant: newTenant,
      message: `Cliente "${newTenant.nombre_comercial}" registrado correctamente.`,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al registrar cliente.' });
  }
});

/**
 * PUT /api/admin/tenants/:id
 * Actualiza los datos fiscales, dirección y contactos de un cliente.
 */
adminRouter.put('/tenants/:id', async (req, res) => {
  try {
    const auth = req.auth!;
    const tenantId = Number(req.params.id);

    if (auth.role !== 'superadmin' && auth.activeTenantId !== tenantId) {
      res.status(403).json({
        ok: false,
        message: 'No tienes permisos para modificar otro cliente.',
      });
      return;
    }

    const parsed = TenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        message: parsed.error.issues[0]?.message || 'Datos del cliente inválidos.',
      });
      return;
    }

    const d = parsed.data;
    const updRes = await db.query(
      `UPDATE tenants SET
        nombre_comercial = $1,
        razon_social = $2,
        rfc = $3,
        regimen_fiscal = $4,
        uso_cfdi = $5,
        email_facturacion = $6,
        calle = $7,
        numero_exterior = $8,
        numero_interior = $9,
        colonia = $10,
        codigo_postal = $11,
        municipio_alcaldia = $12,
        ciudad = $13,
        estado = $14,
        pais = $15,
        contacto_admin_nombre = $16,
        contacto_admin_cargo = $17,
        contacto_admin_email = $18,
        contacto_admin_telefono = $19,
        contacto_tecnico_nombre = $20,
        contacto_tecnico_cargo = $21,
        contacto_tecnico_email = $22,
        contacto_tecnico_telefono = $23,
        activo = $24,
        notas = $25,
        updated_at = NOW()
       WHERE id = $26
       RETURNING *`,
      [
        d.nombre_comercial.trim(),
        d.razon_social.trim(),
        d.rfc.trim().toUpperCase(),
        d.regimen_fiscal.trim(),
        d.uso_cfdi.trim(),
        d.email_facturacion.trim().toLowerCase(),
        d.calle.trim(),
        d.numero_exterior.trim(),
        d.numero_interior.trim(),
        d.colonia.trim(),
        d.codigo_postal.trim(),
        d.municipio_alcaldia.trim(),
        d.ciudad.trim(),
        d.estado.trim(),
        d.pais.trim() || 'México',
        d.contacto_admin_nombre.trim(),
        d.contacto_admin_cargo.trim(),
        d.contacto_admin_email.trim().toLowerCase(),
        d.contacto_admin_telefono.trim(),
        d.contacto_tecnico_nombre.trim(),
        d.contacto_tecnico_cargo.trim(),
        d.contacto_tecnico_email.trim().toLowerCase(),
        d.contacto_tecnico_telefono.trim(),
        d.activo,
        d.notas.trim(),
        tenantId,
      ]
    );

    if ((updRes.rowCount ?? 0) === 0) {
      res.status(404).json({ ok: false, message: 'Cliente no encontrado.' });
      return;
    }

    await authService.logActivity({
      tenantId,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Actualización de datos de cliente',
      modulo: 'Administración > Clientes',
      detalle: `Cliente actualizado: "${updRes.rows[0].nombre_comercial}"`,
    });

    res.json({
      ok: true,
      tenant: updRes.rows[0],
      message: 'Datos del cliente actualizados correctamente.',
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al actualizar cliente.' });
  }
});

/**
 * DELETE /api/admin/tenants/:id
 * Elimina un cliente (Solo SuperAdmin, protege Tenant #1).
 */
adminRouter.delete('/tenants/:id', async (req, res) => {
  try {
    const auth = req.auth!;
    if (auth.role !== 'superadmin') {
      res.status(403).json({ ok: false, message: 'Solo el Super Administrador puede eliminar clientes.' });
      return;
    }

    const tenantId = Number(req.params.id);
    if (tenantId === 1) {
      res.status(400).json({ ok: false, message: 'No se puede eliminar la organización principal (#1).' });
      return;
    }

    const del = await db.query('DELETE FROM tenants WHERE id = $1 RETURNING nombre_comercial', [tenantId]);
    if ((del.rowCount ?? 0) === 0) {
      res.status(404).json({ ok: false, message: 'Cliente no encontrado.' });
      return;
    }

    await authService.logActivity({
      tenantId: 1,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Baja de cliente',
      modulo: 'Administración > Clientes',
      detalle: `Se eliminó el cliente #${tenantId} (${del.rows[0].nombre_comercial})`,
    });

    res.json({ ok: true, message: 'Cliente eliminado correctamente.' });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al eliminar cliente.' });
  }
});

/**
 * GET /api/admin/users
 * Lista los usuarios (SuperAdmin ve todos o filtra por tenant_id; Admin del cliente ve solo los de su cliente).
 */
adminRouter.get('/users', async (req, res) => {
  try {
    const auth = req.auth!;
    const queryTenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;

    const params: any[] = [];
    let whereSql = '';

    if (auth.role !== 'superadmin') {
      params.push(auth.activeTenantId);
      whereSql = 'WHERE u.tenant_id = $1 AND u.role != \'superadmin\'';
    } else if (queryTenantId) {
      params.push(queryTenantId);
      whereSql = 'WHERE u.tenant_id = $1';
    }

    const result = await db.query(
      `SELECT
        u.id, u.tenant_id, u.email, u.nombre_completo, u.cargo, u.telefono,
        u.role, u.activo, u.ultimo_acceso_at, u.created_at,
        t.nombre_comercial AS tenant_nombre, t.rfc AS tenant_rfc
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       ${whereSql}
       ORDER BY u.tenant_id ASC, u.id ASC`,
      params
    );

    res.json({
      ok: true,
      users: result.rows,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al listar usuarios.' });
  }
});

/**
 * POST /api/admin/users
 * Crea un nuevo usuario anclado a su correo electrónico.
 * SuperAdmin puede asignar cualquier cliente y rol; Admin de cliente solo asigna su propio cliente y roles ('admin' | 'analista').
 */
adminRouter.post('/users', async (req, res) => {
  try {
    const auth = req.auth!;
    const parsed = UserCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        message: parsed.error.issues[0]?.message || 'Datos de usuario inválidos.',
      });
      return;
    }

    const d = parsed.data;
    const normalizedEmail = d.email.trim().toLowerCase();

    const targetTenantId =
      auth.role === 'superadmin' ? d.tenant_id || auth.activeTenantId : auth.activeTenantId;
    const targetRole =
      auth.role === 'superadmin' ? d.role : d.role === 'superadmin' ? 'admin' : d.role;

    const dup = await db.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [
      normalizedEmail,
    ]);
    if ((dup.rowCount ?? 0) > 0) {
      res.status(409).json({
        ok: false,
        message: `Ya existe un usuario registrado con el correo "${normalizedEmail}".`,
      });
      return;
    }

    const pwdHash = hashPassword(d.password);
    const ins = await db.query(
      `INSERT INTO users (
        tenant_id, email, nombre_completo, cargo, telefono, password_hash, role, activo
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, tenant_id, email, nombre_completo, cargo, telefono, role, activo, created_at`,
      [
        targetTenantId,
        normalizedEmail,
        d.nombre_completo.trim(),
        d.cargo.trim(),
        d.telefono.trim(),
        pwdHash,
        targetRole,
        d.activo,
      ]
    );

    const newUser = ins.rows[0];

    await authService.logActivity({
      tenantId: targetTenantId,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Alta de usuario',
      modulo: 'Administración > Usuarios',
      detalle: `Creó al usuario ${newUser.email} (${newUser.nombre_completo}) con perfil "${newUser.role}"`,
    });

    res.status(201).json({
      ok: true,
      user: newUser,
      message: `Usuario "${newUser.email}" creado correctamente.`,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al crear usuario.' });
  }
});

/**
 * PUT /api/admin/users/:id
 * Modifica un usuario existente (correo, nombre, rol, cliente, estado activo o contraseña).
 */
adminRouter.put('/users/:id', async (req, res) => {
  try {
    const auth = req.auth!;
    const userId = Number(req.params.id);

    const existingRes = await db.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
    if ((existingRes.rowCount ?? 0) === 0) {
      res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
      return;
    }
    const existing = existingRes.rows[0];

    // Si es Admin de cliente, solo puede editar usuarios de su propio cliente y que no sean superadmin
    if (auth.role !== 'superadmin') {
      if (existing.tenant_id !== auth.activeTenantId || existing.role === 'superadmin') {
        res.status(403).json({
          ok: false,
          message: 'No tienes permisos para modificar este usuario.',
        });
        return;
      }
    }

    const parsed = UserUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        message: parsed.error.issues[0]?.message || 'Datos inválidos.',
      });
      return;
    }
    const d = parsed.data;

    const newEmail = d.email ? d.email.trim().toLowerCase() : existing.email;
    if (newEmail !== existing.email) {
      const dup = await db.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 AND id != $2 LIMIT 1',
        [newEmail, userId]
      );
      if ((dup.rowCount ?? 0) > 0) {
        res.status(409).json({
          ok: false,
          message: `El correo "${newEmail}" ya está asignado a otro usuario.`,
        });
        return;
      }
    }

    const newTenantId =
      auth.role === 'superadmin' && d.tenant_id ? d.tenant_id : existing.tenant_id;
    let newRole = d.role || existing.role;
    if (auth.role !== 'superadmin' && newRole === 'superadmin') {
      newRole = 'admin';
    }

    const newPwdHash =
      d.password && d.password.trim().length >= 6
        ? hashPassword(d.password.trim())
        : existing.password_hash;

    const upd = await db.query(
      `UPDATE users SET
        tenant_id = $1,
        email = $2,
        nombre_completo = $3,
        cargo = $4,
        telefono = $5,
        password_hash = $6,
        role = $7,
        activo = $8,
        updated_at = NOW()
       WHERE id = $9
       RETURNING id, tenant_id, email, nombre_completo, cargo, telefono, role, activo, ultimo_acceso_at, created_at`,
      [
        newTenantId,
        newEmail,
        d.nombre_completo !== undefined ? d.nombre_completo.trim() : existing.nombre_completo,
        d.cargo !== undefined ? d.cargo.trim() : existing.cargo,
        d.telefono !== undefined ? d.telefono.trim() : existing.telefono,
        newPwdHash,
        newRole,
        d.activo !== undefined ? d.activo : existing.activo,
        userId,
      ]
    );

    await authService.logActivity({
      tenantId: newTenantId,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Modificación de usuario',
      modulo: 'Administración > Usuarios',
      detalle: `Actualizó al usuario ${newEmail} (Perfil: ${newRole}, Activo: ${upd.rows[0].activo})`,
    });

    res.json({
      ok: true,
      user: upd.rows[0],
      message: 'Usuario actualizado correctamente.',
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al actualizar usuario.' });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Elimina un usuario.
 */
adminRouter.delete('/users/:id', async (req, res) => {
  try {
    const auth = req.auth!;
    const userId = Number(req.params.id);

    if (userId === auth.userId) {
      res.status(400).json({ ok: false, message: 'No puedes eliminar tu propio usuario en sesión.' });
      return;
    }

    const existingRes = await db.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
    if ((existingRes.rowCount ?? 0) === 0) {
      res.status(404).json({ ok: false, message: 'Usuario no encontrado.' });
      return;
    }
    const existing = existingRes.rows[0];

    if (existing.email.toLowerCase() === 'admin@causer.com.mx') {
      res.status(400).json({
        ok: false,
        message: 'No se puede eliminar la cuenta principal del Super Administrador.',
      });
      return;
    }

    if (auth.role !== 'superadmin' && existing.tenant_id !== auth.activeTenantId) {
      res.status(403).json({ ok: false, message: 'No tienes permisos para eliminar este usuario.' });
      return;
    }

    await db.query('DELETE FROM users WHERE id = $1', [userId]);

    await authService.logActivity({
      tenantId: existing.tenant_id,
      userId: auth.userId,
      userEmail: auth.email,
      userNombre: auth.nombreCompleto,
      userRole: auth.role,
      accion: 'Baja de usuario',
      modulo: 'Administración > Usuarios',
      detalle: `Eliminó al usuario ${existing.email} (${existing.nombre_completo})`,
    });

    res.json({ ok: true, message: 'Usuario eliminado correctamente.' });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al eliminar usuario.' });
  }
});

/**
 * GET /api/admin/activity
 * Consulta la bitácora de actividad filtrada por cliente y/o usuario.
 */
adminRouter.get('/activity', async (req, res) => {
  try {
    const auth = req.auth!;
    const filterTenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
    const filterUserId = req.query.user_id ? Number(req.query.user_id) : null;
    const limit = Math.min(Number(req.query.limit || 100), 300);

    const conditions: string[] = [];
    const params: any[] = [];

    if (auth.role !== 'superadmin') {
      params.push(auth.activeTenantId);
      conditions.push(`a.tenant_id = $${params.length}`);
    } else if (filterTenantId) {
      params.push(filterTenantId);
      conditions.push(`a.tenant_id = $${params.length}`);
    }

    if (filterUserId) {
      params.push(filterUserId);
      conditions.push(`a.user_id = $${params.length}`);
    }

    params.push(limit);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT
        a.*,
        t.nombre_comercial AS tenant_nombre
       FROM activity_logs a
       LEFT JOIN tenants t ON t.id = a.tenant_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({
      ok: true,
      logs: result.rows,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, message: err?.message || 'Error al consultar actividad.' });
  }
});
