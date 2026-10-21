import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const execFileAsync = promisify(execFile);

export interface DiscoveredAttachment {
  url: string;
  label: string;
  fileType: 'pdf' | 'docx' | 'doc';
}

export interface LightpandaPageResult {
  url: string;
  finalUrl: string;
  title: string;
  methodUsed: 'lightpanda_cdp' | 'lightpanda_cli' | 'direct_file_url' | 'http_fetch_fallback';
  isDirectDocumentUrl: boolean;
  directDocumentType?: 'pdf' | 'docx' | 'doc';
  pageText: string;
  attachments: DiscoveredAttachment[];
}

/**
 * Detecta si una URL o Content-Type corresponde directamente a un documento PDF o Word (.docx / .doc).
 */
export function detectDocumentType(urlStr: string, contentType = ''): 'pdf' | 'docx' | 'doc' | null {
  const lowerUrl = urlStr.split('?')[0].toLowerCase();
  const lowerCt = contentType.toLowerCase();

  if (lowerUrl.endsWith('.pdf') || lowerCt.includes('application/pdf')) {
    return 'pdf';
  }
  if (
    lowerUrl.endsWith('.docx') ||
    lowerCt.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  ) {
    return 'docx';
  }
  if (lowerUrl.endsWith('.doc') || lowerCt.includes('application/msword')) {
    return 'doc';
  }
  return null;
}

/**
 * Limpia HTML crudo a texto legible y extrae enlaces a archivos PDF / Word.
 */
function parseHtmlAndExtractAttachments(
  html: string,
  baseUrl: string
): { title: string; text: string; attachments: DiscoveredAttachment[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : baseUrl;

  const attachments: DiscoveredAttachment[] = [];
  const seenUrls = new Set<string>();

  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const rawHref = match[1].trim();
    const rawLabel = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!rawHref || rawHref.startsWith('javascript:') || rawHref.startsWith('#')) continue;

    try {
      const resolved = new URL(rawHref, baseUrl).toString();
      const docType = detectDocumentType(resolved);
      if (docType && !seenUrls.has(resolved)) {
        seenUrls.add(resolved);
        attachments.push({
          url: resolved,
          label: rawLabel || resolved.split('/').pop() || `Documento.${docType}`,
          fileType: docType,
        });
      }
    } catch {
      // URL relativa inválida
    }
  }

  // Convertir HTML a texto limpio preservando saltos de línea de párrafos/bloques
  const cleanedText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();

  return { title, text: cleanedText, attachments };
}

/**
 * Servicio de navegación con Lightpanda Browser (https://github.com/lightpanda-io/browser)
 * Soporta:
 * 1. Servidor CDP Lightpanda (ws://127.0.0.1:9222) vía puppeteer-core
 * 2. Binario CLI Lightpanda (`lightpanda fetch --dump html <url>`)
 * 3. Detección automática de URLs que apuntan directamente a un archivo PDF o Word
 */
export class LightpandaService {
  private cdpEndpoint = process.env.LIGHTPANDA_CDP_URL || 'ws://127.0.0.1:9222';
  private binaryPath = process.env.LIGHTPANDA_BIN || '/usr/local/bin/lightpanda';

  async readTenderUrl(targetUrl: string): Promise<LightpandaPageResult> {
    // 1. Verificar por petición HEAD/GET inicial si la URL apunta directamente a un archivo PDF o Word
    const urlDocType = detectDocumentType(targetUrl);
    if (urlDocType) {
      return {
        url: targetUrl,
        finalUrl: targetUrl,
        title: decodeURIComponent(targetUrl.split('/').pop() || `Documento_${urlDocType.toUpperCase()}`),
        methodUsed: 'direct_file_url',
        isDirectDocumentUrl: true,
        directDocumentType: urlDocType,
        pageText: '',
        attachments: [
          {
            url: targetUrl,
            label: decodeURIComponent(targetUrl.split('/').pop() || 'Documento principal'),
            fileType: urlDocType,
          },
        ],
      };
    }

    try {
      const headRes = await fetch(targetUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      const ct = headRes.headers.get('content-type') || '';
      const detectedByHeader = detectDocumentType(headRes.url || targetUrl, ct);
      if (detectedByHeader) {
        return {
          url: targetUrl,
          finalUrl: headRes.url || targetUrl,
          title: decodeURIComponent((headRes.url || targetUrl).split('/').pop() || 'Documento'),
          methodUsed: 'direct_file_url',
          isDirectDocumentUrl: true,
          directDocumentType: detectedByHeader,
          pageText: '',
          attachments: [
            {
              url: headRes.url || targetUrl,
              label: 'Documento directo de licitación',
              fileType: detectedByHeader,
            },
          ],
        };
      }
    } catch {
      // Continuar con Lightpanda si el servidor no soporta HEAD
    }

    // 2. Intentar conexión a Lightpanda Browser vía CDP (ws://127.0.0.1:9222)
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: this.cdpEndpoint,
      });

      try {
        const page = await browser.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const finalUrl = page.url() || targetUrl;
        const html = await page.content();
        await page.close();

        const parsed = parseHtmlAndExtractAttachments(html, finalUrl);
        return {
          url: targetUrl,
          finalUrl,
          title: parsed.title,
          methodUsed: 'lightpanda_cdp',
          isDirectDocumentUrl: false,
          pageText: parsed.text,
          attachments: parsed.attachments,
        };
      } finally {
        await browser.disconnect();
      }
    } catch {
      // Si el servidor CDP no está corriendo en el puerto 9222, intentar CLI `lightpanda fetch`
    }

    // 3. Intentar CLI `lightpanda fetch --dump html <url>`
    for (const bin of [this.binaryPath, 'lightpanda']) {
      try {
        const { stdout } = await execFileAsync(bin, ['fetch', '--dump', 'html', targetUrl], {
          timeout: 30000,
          maxBuffer: 15 * 1024 * 1024,
        });
        if (stdout && stdout.trim().length > 0) {
          const parsed = parseHtmlAndExtractAttachments(stdout, targetUrl);
          return {
            url: targetUrl,
            finalUrl: targetUrl,
            title: parsed.title,
            methodUsed: 'lightpanda_cli',
            isDirectDocumentUrl: false,
            pageText: parsed.text,
            attachments: parsed.attachments,
          };
        }
      } catch {
        // Intentar siguiente método
      }
    }

    // 4. Fallback HTTP directo para entornos sin el binario Linux de Lightpanda activo
    const res = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Lightpanda/1.0 Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(20000),
    });

    const contentType = res.headers.get('content-type') || '';
    const finalUrl = res.url || targetUrl;
    const detectedType = detectDocumentType(finalUrl, contentType);

    if (detectedType) {
      return {
        url: targetUrl,
        finalUrl,
        title: decodeURIComponent(finalUrl.split('/').pop() || 'Documento'),
        methodUsed: 'direct_file_url',
        isDirectDocumentUrl: true,
        directDocumentType: detectedType,
        pageText: '',
        attachments: [
          {
            url: finalUrl,
            label: decodeURIComponent(finalUrl.split('/').pop() || 'Documento'),
            fileType: detectedType,
          },
        ],
      };
    }

    const html = await res.text();
    const parsed = parseHtmlAndExtractAttachments(html, finalUrl);

    return {
      url: targetUrl,
      finalUrl,
      title: parsed.title,
      methodUsed: 'http_fetch_fallback',
      isDirectDocumentUrl: false,
      pageText: parsed.text,
      attachments: parsed.attachments,
    };
  }
}

export const lightpandaService = new LightpandaService();
