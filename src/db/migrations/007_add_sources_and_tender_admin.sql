-- ============================================================================
-- MIGRACIÓN 007: NUEVOS SITIOS DE INTERÉS GUBERNAMENTALES PARA MONITOREO
-- Y SOPORTE PARA ADMINISTRACIÓN DE LICITACIONES
-- ============================================================================

INSERT INTO scraping_sources (tenant_id, nombre, entidad, url, keywords, frecuencia_horas, activo, proxima_revision_at)
SELECT 1, v.nombre, v.entidad, v.url, v.keywords, v.frecuencia_horas, v.activo, NOW() + (v.offset_min * INTERVAL '1 minute')
FROM (VALUES
  (
    'ComprasMX — Plataforma Pública de Contrataciones',
    'Secretaría de la Función Pública / Gobierno Federal',
    'https://comprasmx.buengobierno.gob.mx/',
    'mantenimiento, desarrollo, adquisición, soporte, fumigación, servicios, consultoría',
    24,
    true,
    5
  ),
  (
    'DOF — Diario Oficial de la Federación',
    'Secretaría de Gobernación',
    'https://www.dof.gob.mx/#gsc.tab=0',
    'convocatoria, licitación pública, adquisición, arrendamiento, servicios, obra pública',
    24,
    true,
    10
  ),
  (
    'Gaceta Oficial de la Ciudad de México',
    'Consejería Jurídica y de Servicios Legales CDMX',
    'https://data.consejeria.cdmx.gob.mx/index.php/gaceta',
    'licitación, convocatoria, adquisición, mantenimiento, servicios, suministros',
    24,
    true,
    15
  ),
  (
    'Periódico Oficial "Gaceta del Gobierno" EdoMéx',
    'Gobierno del Estado de México',
    'https://legislacion.edomex.gob.mx/ve_periodico_oficial',
    'licitación pública, adquisición, contratación, servicios, obra, mantenimiento',
    24,
    true,
    20
  ),
  (
    'ASF — Recursos Materiales y Servicios',
    'Auditoría Superior de la Federación',
    'https://www.asf.gob.mx/Section/87_Recursos_Materiales_y_Servicios',
    'adquisición, licitación, mantenimiento, servicios generales, arrendamiento',
    24,
    true,
    25
  ),
  (
    'SAF CDMX — Trámites y Contrataciones TICs',
    'Secretaría de Administración y Finanzas de la CDMX',
    'https://tics.finanzas.cdmx.gob.mx/validar_tramite/public/',
    'tecnología, cómputo, desarrollo, mantenimiento, sistemas, consultoría',
    24,
    true,
    30
  ),
  (
    'Cámara de Diputados — Portal de Adquisiciones',
    'H. Cámara de Diputados',
    'https://pac.diputados.gob.mx/ords/f?p=2220:1:17223448378209:::::',
    'licitación pública, adquisición, servicios, mantenimiento, soporte, suministros',
    24,
    true,
    35
  ),
  (
    'BANXICO — Portal de Proveedores y Concursos',
    'Banco de México',
    'https://www.banxico.org.mx/PortalProveedores/',
    'adquisición, servicios, mantenimiento, desarrollo, consultoría, sistemas',
    24,
    true,
    40
  ),
  (
    'Poder Judicial CDMX — Licitaciones Públicas (Oficial)',
    'Poder Judicial de la Ciudad de México',
    'https://www.poderjudicialcdmx.gob.mx/licitaciones/',
    'mantenimiento, adquisición, servicios, obra pública, fumigación, limpieza',
    24,
    true,
    45
  ),
  (
    'SCJN — Procedimientos de Contratación Vigentes',
    'Suprema Corte de Justicia de la Nación',
    'https://www.scjn.gob.mx/transparencia/obligaciones-de-transparencia/procedimientos-contratacion-vigentes',
    'licitación pública, invitación restringida, adjudicación, servicios, suministros',
    24,
    true,
    50
  ),
  (
    'OAJ / TEPJF — Convocatorias DGRMSG',
    'Órgano de Administración Judicial / TEPJF',
    'https://www.oaj.gob.mx/convocatoriasDGRMSG.htm#2026',
    'convocatoria, licitación, servicios, recursos materiales, mantenimiento, suministros',
    24,
    true,
    55
  ),
  (
    'CNDH — Licitaciones y Contrataciones Públicas',
    'Comisión Nacional de los Derechos Humanos',
    'http://appweb.cndh.org.mx/contrataciones/act_adqLicitacion.asp',
    'licitación pública, adquisición, servicios, arrendamiento, mantenimiento',
    24,
    true,
    60
  ),
  (
    'TECDMX — Licitaciones y Adjudicaciones',
    'Tribunal Electoral de la Ciudad de México',
    'https://transparencia.tecdmx.org.mx/licitaciones-adjudicaciones-2/',
    'licitación, adjudicación, servicios, adquisiciones, suministros',
    24,
    true,
    65
  ),
  (
    'CFE — Micrositio de Concursos',
    'Comisión Federal de Electricidad',
    'https://msc.cfe.mx/Aplicaciones/NCFE/Concursos/',
    'concurso abierto, servicios, mantenimiento, adquisición, energía, sistemas',
    24,
    true,
    70
  ),
  (
    'TFJA — Convocatorias y Bases 2026',
    'Tribunal Federal de Justicia Administrativa',
    'https://www.tfja.gob.mx/licitaciones/bases2026/',
    'bases, licitación pública, servicios, adquisiciones, mantenimiento',
    24,
    true,
    75
  )
) AS v(nombre, entidad, url, keywords, frecuencia_horas, activo, offset_min)
WHERE NOT EXISTS (
  SELECT 1 FROM scraping_sources s WHERE s.url = v.url
);
