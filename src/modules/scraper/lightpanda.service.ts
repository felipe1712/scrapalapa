import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const execFileAsync = promisify(execFile);

export interface DiscoveredAttachment {
  url: string;
  label: string;
  fileType: 'pdf' | 'docx' | 'doc';
}

export interface LightpandaAuthOptions {
  username?: string;
  password?: string;
  loginUrl?: string;
}

export interface LightpandaPageResult {
  url: string;
  finalUrl: string;
  title: string;
  methodUsed: 'lightpanda_cdp' | 'lightpanda_cli' | 'direct_file_url' | 'http_fetch_fallback';
  authenticated: boolean;
  isDirectDocumentUrl: boolean;
  directDocumentType?: 'pdf' | 'docx' | 'doc';
  pageText: string;
  attachments: DiscoveredAttachment[];
  sessionCookieHeader?: string;
  basicAuthHeader?: string;
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
 * 1. Servidor CDP Lightpanda (ws://127.0.0.1:9222) vía puppeteer-core (con soporte de auto-login en formularios y HTTP Basic Auth)
 * 2. Binario CLI Lightpanda (`lightpanda fetch --dump html <url>`)
 * 3. Detección automática de URLs que apuntan directamente a un archivo PDF o Word
 */
export class LightpandaService {
  private cdpEndpoint = process.env.LIGHTPANDA_CDP_URL || 'ws://127.0.0.1:9222';
  private binaryPath = process.env.LIGHTPANDA_BIN || '/usr/local/bin/lightpanda';

  async readTenderUrl(targetUrl: string, auth?: LightpandaAuthOptions): Promise<LightpandaPageResult> {
    const hasCredentials = Boolean(auth?.username && auth?.password);
    const basicAuthHeader = hasCredentials
      ? `Basic ${Buffer.from(`${auth!.username}:${auth!.password}`).toString('base64')}`
      : undefined;

    let sessionCookieHeader: string | undefined;
    let authenticated = false;

    // 1. Si hay credenciales (o no es archivo directo), intentar primero conexión a Lightpanda Browser vía CDP (ws://127.0.0.1:9222)
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: this.cdpEndpoint,
      });

      try {
        const page = await browser.newPage();

        if (hasCredentials && auth?.username && auth?.password) {
          await page.authenticate({
            username: auth.username,
            password: auth.password,
          });
        }

        // Si el usuario especificó una URL de login explícita, ir primero ahí para iniciar sesión
        if (hasCredentials && auth?.loginUrl) {
          await page.goto(auth.loginUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          authenticated = await this.performFormLoginOnPage(page, auth.username!, auth.password!);
        }

        // Verificar si la URL destino es directamente un archivo PDF/Word
        const directUrlType = detectDocumentType(targetUrl);
        if (directUrlType) {
          const cookies = await page.cookies();
          if (cookies.length > 0) {
            sessionCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          }
          await page.close();
          return {
            url: targetUrl,
            finalUrl: targetUrl,
            title: decodeURIComponent(targetUrl.split('/').pop() || `Documento_${directUrlType.toUpperCase()}`),
            methodUsed: 'direct_file_url',
            authenticated: authenticated || hasCredentials,
            isDirectDocumentUrl: true,
            directDocumentType: directUrlType,
            pageText: '',
            attachments: [
              {
                url: targetUrl,
                label: decodeURIComponent(targetUrl.split('/').pop() || 'Documento principal'),
                fileType: directUrlType,
              },
            ],
            sessionCookieHeader,
            basicAuthHeader,
          };
        }

        // Navegar a la URL objetivo de la licitación
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Si hay credenciales y la página redirigió a un formulario de login (o contiene input[type="password"]), iniciar sesión
        if (hasCredentials && auth?.username && auth?.password) {
          const loggedInNow = await this.performFormLoginOnPage(page, auth.username, auth.password);
          if (loggedInNow) {
            authenticated = true;
            // Si tras el login no estamos en targetUrl, volver a navegar a targetUrl ya con la sesión iniciada
            if (page.url() !== targetUrl) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            }
          }
        }

        const cookies = await page.cookies();
        if (cookies.length > 0) {
          sessionCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        }

        const finalUrl = page.url() || targetUrl;
        const html = await page.content();
        await page.close();

        const parsed = parseHtmlAndExtractAttachments(html, finalUrl);
        return {
          url: targetUrl,
          finalUrl,
          title: parsed.title,
          methodUsed: 'lightpanda_cdp',
          authenticated: authenticated || hasCredentials,
          isDirectDocumentUrl: false,
          pageText: parsed.text,
          attachments: parsed.attachments,
          sessionCookieHeader,
          basicAuthHeader,
        };
      } finally {
        await browser.disconnect();
      }
    } catch {
      // Si el servidor CDP no está corriendo en el puerto 9222, continuar con detección de archivo / CLI / HTTP
    }

    // 2. Verificar si la URL apunta directamente a un archivo PDF o Word
    const urlDocType = detectDocumentType(targetUrl);
    if (urlDocType) {
      return {
        url: targetUrl,
        finalUrl: targetUrl,
        title: decodeURIComponent(targetUrl.split('/').pop() || `Documento_${urlDocType.toUpperCase()}`),
        methodUsed: 'direct_file_url',
        authenticated: hasCredentials,
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
        sessionCookieHeader,
        basicAuthHeader,
      };
    }

    // 3. Intentar CLI `lightpanda fetch --dump html <url>` (cuando no requiere login interactivo por formulario)
    if (!hasCredentials) {
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
              authenticated: false,
              isDirectDocumentUrl: false,
              pageText: parsed.text,
              attachments: parsed.attachments,
            };
          }
        } catch {
          // Intentar siguiente método
        }
      }
    }

    // 4. Fallback HTTP (con soporte de Basic Auth y envío de formulario si se proporcionaron credenciales)
    const reqHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Lightpanda/1.0 Chrome/124.0.0.0 Safari/537.36',
    };
    if (basicAuthHeader) {
      reqHeaders['Authorization'] = basicAuthHeader;
    }

    const res = await fetch(targetUrl, {
      redirect: 'follow',
      headers: reqHeaders,
      signal: AbortSignal.timeout(20000),
    });

    const setCookieHeader = res.headers.get('set-cookie');
    if (setCookieHeader) {
      sessionCookieHeader = setCookieHeader
        .split(',')
        .map((c) => c.split(';')[0].trim())
        .join('; ');
    }

    const contentType = res.headers.get('content-type') || '';
    const finalUrl = res.url || targetUrl;
    const detectedType = detectDocumentType(finalUrl, contentType);

    if (detectedType) {
      return {
        url: targetUrl,
        finalUrl,
        title: decodeURIComponent(finalUrl.split('/').pop() || 'Documento'),
        methodUsed: 'direct_file_url',
        authenticated: hasCredentials,
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
        sessionCookieHeader,
        basicAuthHeader,
      };
    }

    const html = await res.text();
    const parsed = parseHtmlAndExtractAttachments(html, finalUrl);

    return {
      url: targetUrl,
      finalUrl,
      title: parsed.title,
      methodUsed: 'http_fetch_fallback',
      authenticated: hasCredentials,
      isDirectDocumentUrl: false,
      pageText: parsed.text,
      attachments: parsed.attachments,
      sessionCookieHeader,
      basicAuthHeader,
    };
  }

  /**
   * Detecta automáticamente campos de usuario y contraseña en la página actual de Lightpanda (CDP),
   * inyecta las credenciales y envía el formulario esperando la navegación.
   */
  private async performFormLoginOnPage(page: any, username: string, password: string): Promise<boolean> {
    try {
      const hasPasswordInput = await page.evaluate(() => {
        return Boolean(document.querySelector('input[type="password"]'));
      });

      if (!hasPasswordInput) {
        return false;
      }

      const filledAndSubmitted = await page.evaluate(
        (creds: { user: string; pass: string }) => {
          const passInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
          if (!passInput) return false;

          const form = passInput.closest('form') || document.body;

          // Buscar el input de usuario dentro del mismo formulario o documento
          const candidates = Array.from(
            form.querySelectorAll(
              'input[type="text"], input[type="email"], input[name*="user" i], input[name*="usuario" i], input[name*="login" i], input[name*="email" i], input[name*="correo" i], input[name*="rfc" i], input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
            )
          ) as HTMLInputElement[];

          const userInput = candidates[0];

          const setNativeValue = (el: HTMLInputElement, val: string) => {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };

          if (userInput) {
            setNativeValue(userInput, creds.user);
          }
          setNativeValue(passInput, creds.pass);

          const submitBtn = form.querySelector(
            'button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])'
          ) as HTMLElement | null;

          if (submitBtn) {
            submitBtn.click();
          } else if (form instanceof HTMLFormElement) {
            form.submit();
          }
          return true;
        },
        { user: username, pass: password }
      );

      if (filledAndSubmitted) {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export const lightpandaService = new LightpandaService();
