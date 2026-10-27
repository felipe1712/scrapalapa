import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db } from '../../db/pool.js';
import { decryptApiKey } from '../llm/crypto.service.js';
import { normalizeForSearch, parseKeywordsList } from '../scraper/lightpanda.service.js';
import { tenderIngestionService } from '../tenders/tender-ingestion.service.js';

export interface EmailAccountRecord {
  id: number;
  tenant_id: number;
  nombre: string;
  email_address: string;
  imap_host: string;
  imap_port: number;
  imap_tls: boolean;
  imap_user: string;
  imap_password_encrypted: string | null;
  mailbox: string;
  filtro_keywords: string;
  usar_lightpanda_links: boolean;
  frecuencia_horas: number;
  activo: boolean;
  last_seen_uid: number;
  ultima_revision_at: string | null;
  proxima_revision_at: string | null;
  ultimo_resultado: string;
  ultimo_mensaje: string | null;
  total_correos_procesados: number;
  total_licitaciones_encontradas: number;
}

function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  const filtered = matches
    .map((u) => u.replace(/[.,;]+$/, ''))
    .filter((u) => {
      const lower = u.toLowerCase();
      if (
        lower.includes('unsubscribe') ||
        lower.includes('baja') ||
        lower.includes('privacy') ||
        lower.includes('facebook.com') ||
        lower.includes('twitter.com') ||
        lower.includes('linkedin.com') ||
        lower.includes('instagram.com') ||
        lower.endsWith('.png') ||
        lower.endsWith('.jpg') ||
        lower.endsWith('.gif') ||
        lower.endsWith('.svg')
      ) {
        return false;
      }
      return true;
    });
  return Array.from(new Set(filtered)).slice(0, 5);
}

export class EmailMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private isSyncing = false;
  private activeAccountIds = new Set<number>();

  startScheduler(intervalMs = 60_000): void {
    if (this.timer) return;
    console.log(
      `[EmailMonitor] Scheduler de Correo E iniciado (revisión automática cada 24h por cuenta activa).`
    );

    setTimeout(() => {
      this.checkAndRunDueAccounts().catch((err) =>
        console.error('[EmailMonitor] Error en ciclo inicial:', err?.message)
      );
    }, 12_000);

    this.timer = setInterval(() => {
      this.checkAndRunDueAccounts().catch((err) =>
        console.error('[EmailMonitor] Error en ciclo periódico:', err?.message)
      );
    }, intervalMs);
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async testConnection(params: {
    imap_host: string;
    imap_port: number;
    imap_tls: boolean;
    imap_user: string;
    imap_password?: string;
    existing_account_id?: number;
    mailbox?: string;
  }) {
    let passwordToUse = params.imap_password?.trim() || '';
    if ((!passwordToUse || passwordToUse.includes('•')) && params.existing_account_id) {
      const res = await db.query(
        'SELECT imap_password_encrypted FROM email_accounts WHERE id = $1 LIMIT 1',
        [params.existing_account_id]
      );
      if ((res.rowCount ?? 0) > 0 && res.rows[0].imap_password_encrypted) {
        passwordToUse = decryptApiKey(res.rows[0].imap_password_encrypted) || '';
      }
    }

    if (!passwordToUse) {
      throw new Error('Ingresa la contraseña o Contraseña de Aplicación del correo para probar la conexión.');
    }

    const client = new ImapFlow({
      host: params.imap_host.trim(),
      port: Number(params.imap_port || 993),
      secure: params.imap_tls !== false,
      auth: {
        user: params.imap_user.trim(),
        pass: passwordToUse,
      },
      logger: false,
      tls: {
        rejectUnauthorized: false,
      },
    });

    const startTime = Date.now();
    try {
      await client.connect();
      const mailboxName = (params.mailbox || 'INBOX').trim() || 'INBOX';
      const mailboxInfo = await client.mailboxOpen(mailboxName, { readOnly: true });
      const latencyMs = Date.now() - startTime;
      const totalMessages = mailboxInfo.exists || 0;
      const uidNext = mailboxInfo.uidNext || 1;
      await client.logout();

      return {
        ok: true,
        latency_ms: latencyMs,
        mailbox: mailboxName,
        total_messages: totalMessages,
        uid_next: uidNext,
        message: `Conexión IMAP exitosa con ${params.imap_host} (${mailboxName}: ${totalMessages} mensajes en buzón) en ${latencyMs} ms.`,
      };
    } catch (err: any) {
      try {
        await client.close();
      } catch {
        // ignore
      }
      throw new Error(
        `No se pudo conectar al servidor IMAP (${params.imap_host}:${params.imap_port}): ${err?.responseText || err?.message || err}`
      );
    }
  }

  async checkAndRunDueAccounts(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const dueRes = await db.query<EmailAccountRecord>(
        `SELECT *
         FROM email_accounts
         WHERE activo = TRUE
           AND (proxima_revision_at IS NULL OR proxima_revision_at <= NOW())
         ORDER BY proxima_revision_at ASC NULLS FIRST`
      );

      for (const account of dueRes.rows) {
        if (this.activeAccountIds.has(account.id)) continue;
        try {
          await this.syncAccountById(account.id);
        } catch (err: any) {
          console.error(
            `[EmailMonitor] Error aislado en cuenta #${account.id} (${account.email_address}):`,
            err?.message
          );
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  async syncAccountById(accountId: number) {
    if (this.activeAccountIds.has(accountId)) {
      return {
        ok: false,
        alreadyRunning: true,
        message: 'Esta cuenta de correo ya se está sincronizando en este momento.',
      };
    }

    const accRes = await db.query<EmailAccountRecord>(
      'SELECT * FROM email_accounts WHERE id = $1 LIMIT 1',
      [accountId]
    );
    if ((accRes.rowCount ?? 0) === 0) {
      throw new Error(`La cuenta de correo #${accountId} no existe.`);
    }

    const account = accRes.rows[0];
    const password = account.imap_password_encrypted
      ? decryptApiKey(account.imap_password_encrypted)
      : null;

    if (!password) {
      await db.query(
        `UPDATE email_accounts
         SET ultimo_resultado = 'error',
             ultimo_mensaje = 'Falta configurar la contraseña IMAP de la cuenta.',
             ultima_revision_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [account.id]
      );
      throw new Error('La cuenta de correo no tiene una contraseña válida configurada.');
    }

    this.activeAccountIds.add(accountId);
    await db.query(
      `UPDATE email_accounts SET ultimo_resultado = 'running', ultimo_mensaje = 'Conectando al buzón IMAP y buscando correos nuevos...', updated_at = NOW() WHERE id = $1`,
      [account.id]
    );

    const client = new ImapFlow({
      host: account.imap_host.trim(),
      port: Number(account.imap_port || 993),
      secure: account.imap_tls !== false,
      auth: {
        user: account.imap_user.trim(),
        pass: password,
      },
      logger: false,
      tls: {
        rejectUnauthorized: false,
      },
    });

    let highestUidSeen = Number(account.last_seen_uid || 0);
    let emailsChecked = 0;
    let newTendersCreated = 0;
    let skippedOrDuplicates = 0;

    try {
      await client.connect();
      const mailboxName = (account.mailbox || 'INBOX').trim() || 'INBOX';
      const mb = await client.mailboxOpen(mailboxName, { readOnly: true });

      const keywordsList = parseKeywordsList(account.filtro_keywords);
      const normalizedKeywords = keywordsList.map((k) => normalizeForSearch(k));

      let searchQuery: any;
      if (highestUidSeen > 0) {
        searchQuery = { uid: `${highestUidSeen + 1}:*` };
      } else {
        // Primera vez: revisar correos de los últimos 7 días
        const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        searchQuery = { since: sinceDate };
      }

      const rawMessages: Array<{ uid: number; source: Buffer }> = [];
      if ((mb.exists || 0) > 0) {
        for await (const msg of client.fetch(searchQuery, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= account.last_seen_uid) continue;
          if (msg.source) {
            rawMessages.push({ uid: msg.uid, source: msg.source });
          }
        }
      }

      await client.logout();

      // Ordenar por UID ascendente y limitar a los últimos 15 correos por corrida para proteger cuota
      rawMessages.sort((a, b) => a.uid - b.uid);
      const batchToProcess = rawMessages.slice(-15);

      for (const rawItem of batchToProcess) {
        emailsChecked += 1;
        if (rawItem.uid > highestUidSeen) {
          highestUidSeen = rawItem.uid;
        }

        try {
          const parsed = await simpleParser(rawItem.source);
          const messageId = (parsed.messageId || `uid-${account.id}-${rawItem.uid}`).slice(0, 250);
          const subject = (parsed.subject || '(Sin asunto)').trim();
          const fromAddress = (parsed.from?.text || 'remitente-desconocido').trim();
          const receivedAt = parsed.date || new Date();
          const bodyText = (parsed.text || parsed.html || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          // Verificar si este message_id ya fue procesado antes
          const dupMsg = await db.query(
            'SELECT id FROM email_messages_log WHERE email_account_id = $1 AND message_id = $2 LIMIT 1',
            [account.id, messageId]
          );
          if ((dupMsg.rowCount ?? 0) > 0) {
            skippedOrDuplicates += 1;
            continue;
          }

          // Extraer adjuntos PDF o Word (.pdf, .docx, .doc)
          const validAttachments: Array<{ fileName: string; contentType: string; buffer: Buffer }> = [];
          for (const att of parsed.attachments || []) {
            const fname = (att.filename || '').toLowerCase();
            const ctype = (att.contentType || '').toLowerCase();
            if (
              fname.endsWith('.pdf') ||
              fname.endsWith('.docx') ||
              fname.endsWith('.doc') ||
              ctype.includes('pdf') ||
              ctype.includes('word') ||
              ctype.includes('officedocument')
            ) {
              validAttachments.push({
                fileName: att.filename || 'adjunto_licitacion.pdf',
                contentType: att.contentType || 'application/pdf',
                buffer: att.content,
              });
            }
          }

          // Verificar si cumple con el filtro de palabras clave (o si tiene adjuntos PDF/DOCX de licitación)
          const normCombined = normalizeForSearch(
            `${subject} ${bodyText} ${validAttachments.map((a) => a.fileName).join(' ')}`
          );
          const matchesKeywords =
            normalizedKeywords.length === 0 ||
            normalizedKeywords.some((kw) => normCombined.includes(kw)) ||
            validAttachments.length > 0;

          if (!matchesKeywords) {
            await db.query(
              `INSERT INTO email_messages_log (
                email_account_id, tenant_id, message_id, uid, subject, from_address, received_at,
                attachments_count, links_scraped_count, status, detalle
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'skipped', 'Omitido: no contiene palabras clave ni adjuntos de licitación')
              ON CONFLICT (email_account_id, message_id) DO NOTHING`,
              [
                account.id,
                account.tenant_id,
                messageId,
                rawItem.uid,
                subject,
                fromAddress,
                receivedAt.toISOString(),
                validAttachments.length,
              ]
            );
            skippedOrDuplicates += 1;
            continue;
          }

          const extractedUrls = extractUrlsFromText(parsed.text || parsed.html || '');

          const ingestRes = await tenderIngestionService.ingestFromEmailMessage({
            tenantId: account.tenant_id,
            emailAccountId: account.id,
            emailAccountName: account.nombre,
            messageId,
            subject,
            fromAddress,
            receivedAt,
            bodyText: bodyText.slice(0, 35000),
            keywords: keywordsList,
            usarLightpandaLinks: account.usar_lightpanda_links,
            attachments: validAttachments,
            extractedUrls,
          });

          if (ingestRes.skippedDuplicate) {
            skippedOrDuplicates += 1;
            await db.query(
              `INSERT INTO email_messages_log (
                email_account_id, tenant_id, message_id, uid, subject, from_address, received_at,
                attachments_count, links_scraped_count, tender_id, status, detalle
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, 'duplicate', 'Licitación ya existente (deduplicada)')
              ON CONFLICT (email_account_id, message_id) DO NOTHING`,
              [
                account.id,
                account.tenant_id,
                messageId,
                rawItem.uid,
                subject,
                fromAddress,
                receivedAt.toISOString(),
                validAttachments.length,
                ingestRes.tenderId || null,
              ]
            );
          } else {
            newTendersCreated += 1;
            await db.query(
              `INSERT INTO email_messages_log (
                email_account_id, tenant_id, message_id, uid, subject, from_address, received_at,
                attachments_count, links_scraped_count, tender_id, status, detalle
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'processed', $11)
              ON CONFLICT (email_account_id, message_id) DO NOTHING`,
              [
                account.id,
                account.tenant_id,
                messageId,
                rawItem.uid,
                subject,
                fromAddress,
                receivedAt.toISOString(),
                validAttachments.length,
                ingestRes.linksScrapedCount || 0,
                ingestRes.tenderId || null,
                `Licitación #${ingestRes.tenderId} generada (${validAttachments.length} adjunto(s), ${ingestRes.linksScrapedCount || 0} enlace(s) Lightpanda)`,
              ]
            );
          }
        } catch (msgErr: any) {
          console.error(`[EmailMonitor] Error procesando correo UID ${rawItem.uid}:`, msgErr?.message);
        }
      }

      const summaryMsg =
        emailsChecked === 0
          ? 'No llegaron correos nuevos desde la última revisión.'
          : `${emailsChecked} correo(s) nuevo(s) revisado(s): ${newTendersCreated} licitación(es) nueva(s) extraída(s), ${skippedOrDuplicates} omitido(s)/duplicado(s).`;

      await db.query(
        `UPDATE email_accounts
         SET last_seen_uid = $1,
             ultima_revision_at = NOW(),
             proxima_revision_at = NOW() + ($2 || ' hours')::interval,
             ultimo_resultado = 'success',
             ultimo_mensaje = $3,
             total_correos_procesados = total_correos_procesados + $4,
             total_licitaciones_encontradas = total_licitaciones_encontradas + $5,
             updated_at = NOW()
         WHERE id = $6`,
        [
          highestUidSeen,
          String(account.frecuencia_horas || 24),
          summaryMsg,
          emailsChecked,
          newTendersCreated,
          account.id,
        ]
      );

      return {
        ok: true,
        emails_checked: emailsChecked,
        new_tenders: newTendersCreated,
        skipped_or_duplicates: skippedOrDuplicates,
        last_seen_uid: highestUidSeen,
        message: summaryMsg,
      };
    } catch (err: any) {
      try {
        await client.close();
      } catch {
        // ignore
      }
      const errMsg = err?.responseText || err?.message || String(err);
      await db.query(
        `UPDATE email_accounts
         SET ultima_revision_at = NOW(),
             proxima_revision_at = NOW() + ($1 || ' hours')::interval,
             ultimo_resultado = 'error',
             ultimo_mensaje = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [String(account.frecuencia_horas || 24), errMsg.slice(0, 500), account.id]
      );
      throw new Error(errMsg);
    } finally {
      this.activeAccountIds.delete(accountId);
    }
  }
}

export const emailMonitorService = new EmailMonitorService();
