import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const execFileAsync = promisify(execFile);

export interface DiscoveredAttachment {
  url: string;
  label: string;
  fileType: 'pdf' | 'docx' | 'doc';
  matchedKeyword?: string;
  fromHitContext?: string;
}

export interface KeywordHit {
  matchedKeywords: string[];
  contextSnippet: string;
  sourceUrl: string;
  detailUrl?: string;
  documentUrls: string[];
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
  keywordsSearched: string[];
  keywordHits: KeywordHit[];
  sessionCookieHeader?: string;
  basicAuthHeader?: string;
}

/**
 * Normaliza texto para búsqueda insensible a mayúsculas y acentos/tildes.
 */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convierte una cadena separada por comas (o arreglo) en lista limpia de palabras clave.
 */
export function parseKeywordsList(raw?: string | string[]): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.split(',');
  return Array.from(
    new Set(
      list
        .map((k) => k.trim())
        .filter((k) => k.length >= 2)
    )
  );
}

/**
 * Detecta si una URL o Content-Type corresponde directamente a un documento PDF o Word (.docx / .doc).
 */
export function detectDocumentType(
  urlStr: string,
  contentType = '',
  linkLabel = ''
): 'pdf' | 'docx' | 'doc' | null {
  const lowerUrl = urlStr.split('?')[0].toLowerCase();
  const lowerFullUrl = urlStr.toLowerCase();
  const lowerCt = contentType.toLowerCase();
  const lowerLabel = linkLabel.toLowerCase();

  if (
    lowerUrl.endsWith('.pdf') ||
    lowerCt.includes('application/pdf') ||
    lowerFullUrl.includes('format=pdf') ||
    lowerFullUrl.includes('tipo=pdf')
  ) {
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

  // Detectar enlaces de descarga de bases/convocatorias en portales aunque no terminen en .pdf
  if (
    (lowerFullUrl.includes('descarga') ||
      lowerFullUrl.includes('download') ||
      lowerFullUrl.includes('archivo') ||
      lowerFullUrl.includes('documento') ||
      lowerFullUrl.includes('anexo') ||
      lowerFullUrl.includes('bases') ||
      lowerFullUrl.includes('convocatoria')) &&
    (lowerLabel.includes('pdf') ||
      lowerLabel.includes('bases') ||
      lowerLabel.includes('convocatoria') ||
      lowerLabel.includes('licitaci') ||
      lowerLabel.includes('descargar') ||
      lowerLabel.includes('documento') ||
      lowerLabel.includes('anexo'))
  ) {
    if (lowerLabel.includes('word') || lowerLabel.includes('docx')) return 'docx';
    return 'pdf';
  }

  return null;
}

/**
 * Analiza bloques HTML (filas de tablas <tr>, artículos, tarjetas, bloques) buscando coincidencias ("hits")
 * con las palabras clave indicadas y extrae los enlaces a documentos o subpáginas de cada hit.
 */
function analyzeHtmlWithKeywords(
  html: string,
  baseUrl: string,
  keywords: string[]
): {
  title: string;
  text: string;
  attachments: DiscoveredAttachment[];
  keywordHits: KeywordHit[];
  candidateDetailUrls: { url: string; matchedKeywords: string[]; snippet: string }[];
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : baseUrl;

  const cleanHtmlForBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  const allAttachments: DiscoveredAttachment[] = [];
  const seenAttachmentUrls = new Set<string>();

  const extractLinksFromFragment = (
    fragmentHtml: string
  ): { docs: DiscoveredAttachment[]; detailLinks: { url: string; label: string }[] } => {
    const docs: DiscoveredAttachment[] = [];
    const detailLinks: { url: string; label: string }[] = [];
    const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;

    while ((m = linkRegex.exec(fragmentHtml)) !== null) {
      const rawHref = m[1].trim().replace(/&amp;/g, '&');
      const rawLabel = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (
        !rawHref ||
        rawHref.startsWith('javascript:') ||
        rawHref.startsWith('#') ||
        rawHref.startsWith('mailto:') ||
        rawHref.startsWith('tel:')
      ) {
        continue;
      }

      try {
        const resolved = new URL(rawHref, baseUrl).toString();
        const docType = detectDocumentType(resolved, '', rawLabel);
        if (docType) {
          docs.push({
            url: resolved,
            label: rawLabel || decodeURIComponent(resolved.split('/').pop() || `Documento.${docType}`),
            fileType: docType,
          });
        } else {
          const parsedBase = new URL(baseUrl);
          const parsedResolved = new URL(resolved);
          if (parsedResolved.hostname === parsedBase.hostname && resolved !== baseUrl) {
            detailLinks.push({
              url: resolved,
              label: rawLabel || resolved,
            });
          }
        }
      } catch {
        // Ignorar URL malformada
      }
    }
    return { docs, detailLinks };
  };

  // Extraer todos los adjuntos generales de la página
  const globalLinks = extractLinksFromFragment(cleanHtmlForBlocks);
  for (const doc of globalLinks.docs) {
    if (!seenAttachmentUrls.has(doc.url)) {
      seenAttachmentUrls.add(doc.url);
      allAttachments.push(doc);
    }
  }

  // Convertir HTML a texto limpio preservando saltos de línea
  const cleanedText = cleanHtmlForBlocks
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

  const keywordHits: KeywordHit[] = [];
  const candidateDetailUrls: { url: string; matchedKeywords: string[]; snippet: string }[] = [];

  if (keywords.length === 0) {
    return {
      title,
      text: cleanedText,
      attachments: allAttachments,
      keywordHits,
      candidateDetailUrls,
    };
  }

  const normalizedKeywords = keywords.map((kw) => ({
    original: kw,
    norm: normalizeForSearch(kw),
  }));

  // Dividir el HTML en bloques lógicos de licitaciones: filas <tr>, items <li>, <article>, tarjetas <div>
  const blockRegex = /<(tr|article|li|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const matchedAttachmentsPriority: DiscoveredAttachment[] = [];
  const seenSnippets = new Set<string>();
  const seenDetailUrls = new Set<string>();

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(cleanHtmlForBlocks)) !== null) {
    const blockHtml = blockMatch[0];
    const blockPlain = blockHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Evitar bloques vacíos o contenedores gigantes que abarcan toda la página
    if (blockPlain.length < 15 || blockPlain.length > 3500) continue;

    const normBlock = normalizeForSearch(blockPlain);
    const matchedKws = normalizedKeywords
      .filter((k) => normBlock.includes(k.norm))
      .map((k) => k.original);

    if (matchedKws.length > 0) {
      const snippet = blockPlain.slice(0, 320);
      const snippetKey = normalizeForSearch(snippet.slice(0, 120));
      if (seenSnippets.has(snippetKey)) continue;
      seenSnippets.add(snippetKey);

      const { docs, detailLinks } = extractLinksFromFragment(blockHtml);
      const docUrls: string[] = [];

      for (const d of docs) {
        docUrls.push(d.url);
        matchedAttachmentsPriority.push({
          ...d,
          matchedKeyword: matchedKws.join(', '),
          fromHitContext: snippet.slice(0, 140),
        });
      }

      const bestDetailLink = detailLinks[0]?.url;
      if (bestDetailLink && !seenDetailUrls.has(bestDetailLink)) {
        seenDetailUrls.add(bestDetailLink);
        candidateDetailUrls.push({
          url: bestDetailLink,
          matchedKeywords: matchedKws,
          snippet,
        });
      }

      keywordHits.push({
        matchedKeywords: matchedKws,
        contextSnippet: snippet,
        sourceUrl: baseUrl,
        detailUrl: bestDetailLink,
        documentUrls: docUrls,
      });
    }
  }

  // Si no se detectaron hits en bloques pequeños (<tr/li/article>), buscar en párrafos/líneas del texto general
  if (keywordHits.length === 0) {
    const paragraphs = cleanedText.split('\n').map((p) => p.trim()).filter((p) => p.length > 10);
    for (const para of paragraphs) {
      const normPara = normalizeForSearch(para);
      const matchedKws = normalizedKeywords
        .filter((k) => normPara.includes(k.norm))
        .map((k) => k.original);

      if (matchedKws.length > 0) {
        const snippet = para.slice(0, 320);
        const snippetKey = normalizeForSearch(snippet.slice(0, 120));
        if (seenSnippets.has(snippetKey)) continue;
        seenSnippets.add(snippetKey);

        keywordHits.push({
          matchedKeywords: matchedKws,
          contextSnippet: snippet,
          sourceUrl: baseUrl,
          documentUrls: allAttachments.map((a) => a.url),
        });

        // Si el documento/página completa hizo hit, marcar todos sus documentos adjuntos con la palabra clave
        for (const att of allAttachments) {
          matchedAttachmentsPriority.push({
            ...att,
            matchedKeyword: matchedKws.join(', '),
            fromHitContext: snippet.slice(0, 140),
          });
        }
      }
    }
  }

  // Ordenar adjuntos: primero los que pertenecen directamente a un "Hit" de palabra clave
  const prioritizedAttachments: DiscoveredAttachment[] = [];
  const seenPrioUrls = new Set<string>();

  for (const d of matchedAttachmentsPriority) {
    if (!seenPrioUrls.has(d.url)) {
      seenPrioUrls.add(d.url);
      prioritizedAttachments.push(d);
    }
  }
  for (const d of allAttachments) {
    if (!seenPrioUrls.has(d.url)) {
      seenPrioUrls.add(d.url);
      prioritizedAttachments.push(d);
    }
  }

  return {
    title,
    text: cleanedText,
    attachments: prioritizedAttachments,
    keywordHits,
    candidateDetailUrls,
  };
}

/**
 * Servicio de navegación con Lightpanda Browser (https://github.com/lightpanda-io/browser)
 * Soporta:
 * 1. Búsqueda activa de palabras clave separadas por coma ("mantenimiento", "desarrollo", "adquisición", etc.)
 * 2. Seguimiento automático de "Hits" para localizar y traer el documento PDF/Word de la licitación
 * 3. Autenticación (Usuario/Contraseña en formulario o Basic Auth)
 */
export class LightpandaService {
  private cdpEndpoint = process.env.LIGHTPANDA_CDP_URL || 'ws://127.0.0.1:9222';
  private binaryPath = process.env.LIGHTPANDA_BIN || '/usr/local/bin/lightpanda';

  async readTenderUrl(
    targetUrl: string,
    auth?: LightpandaAuthOptions,
    rawKeywords?: string | string[]
  ): Promise<LightpandaPageResult> {
    const keywords = parseKeywordsList(rawKeywords);
    const hasCredentials = Boolean(auth?.username && auth?.password);
    const basicAuthHeader = hasCredentials
      ? `Basic ${Buffer.from(`${auth!.username}:${auth!.password}`).toString('base64')}`
      : undefined;

    let sessionCookieHeader: string | undefined;
    let authenticated = false;

    // 1. Intentar conexión a Lightpanda Browser vía CDP (ws://127.0.0.1:9222)
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

        if (hasCredentials && auth?.loginUrl) {
          await page.goto(auth.loginUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          authenticated = await this.performFormLoginOnPage(page, auth.username!, auth.password!);
        }

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
            keywordsSearched: keywords,
            keywordHits: [],
            sessionCookieHeader,
            basicAuthHeader,
          };
        }

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        if (hasCredentials && auth?.username && auth?.password) {
          const loggedInNow = await this.performFormLoginOnPage(page, auth.username, auth.password);
          if (loggedInNow) {
            authenticated = true;
            if (page.url() !== targetUrl) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            }
          }
        }

        let finalUrl = page.url() || targetUrl;
        let html = await page.content();
        let parsed = analyzeHtmlWithKeywords(html, finalUrl, keywords);

        // Si el usuario especificó palabras clave y aún no hay ningún "hit" en la vista inicial,
        // intentar usar el buscador interno de la página con Lightpanda
        if (keywords.length > 0 && parsed.keywordHits.length === 0) {
          const searchedInPage = await this.tryPortalSearchInput(page, keywords[0]);
          if (searchedInPage) {
            finalUrl = page.url() || finalUrl;
            html = await page.content();
            parsed = analyzeHtmlWithKeywords(html, finalUrl, keywords);
          }
        }

        // Si hubo "Hits" de palabras clave pero el documento PDF/Word está dentro del enlace de detalle del Hit,
        // Lightpanda entra automáticamente a las subpáginas de los Hits (hasta 3) para traer sus documentos PDF/Word
        const extraTexts: string[] = [];
        const hitDocsCount = parsed.attachments.filter((a) => Boolean(a.matchedKeyword)).length;

        if (keywords.length > 0 && parsed.candidateDetailUrls.length > 0 && hitDocsCount === 0) {
          for (const candidate of parsed.candidateDetailUrls.slice(0, 3)) {
            try {
              await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
              const subUrl = page.url() || candidate.url;
              const subHtml = await page.content();
              const subParsed = analyzeHtmlWithKeywords(subHtml, subUrl, keywords);

              if (subParsed.text) {
                extraTexts.push(
                  `=== DETALLE DE LICITACIÓN DETECTADA POR HIT [${candidate.matchedKeywords.join(', ')}] (${subUrl}) ===\n${subParsed.text}`
                );
              }

              for (const subDoc of subParsed.attachments) {
                if (!parsed.attachments.some((existing) => existing.url === subDoc.url)) {
                  parsed.attachments.unshift({
                    ...subDoc,
                    matchedKeyword: candidate.matchedKeywords.join(', '),
                    fromHitContext: candidate.snippet.slice(0, 140),
                  });
                }
                // Asociar el documento encontrado al Hit correspondiente
                const matchingHit = parsed.keywordHits.find((h) => h.detailUrl === candidate.url);
                if (matchingHit && !matchingHit.documentUrls.includes(subDoc.url)) {
                  matchingHit.documentUrls.push(subDoc.url);
                }
              }
            } catch {
              // Continuar con el siguiente hit
            }
          }
        }

        const cookies = await page.cookies();
        if (cookies.length > 0) {
          sessionCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        }

        await page.close();

        const combinedPageText = [parsed.text, ...extraTexts].filter(Boolean).join('\n\n');

        return {
          url: targetUrl,
          finalUrl,
          title: parsed.title,
          methodUsed: 'lightpanda_cdp',
          authenticated: authenticated || hasCredentials,
          isDirectDocumentUrl: false,
          pageText: combinedPageText,
          attachments: parsed.attachments,
          keywordsSearched: keywords,
          keywordHits: parsed.keywordHits,
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
        keywordsSearched: keywords,
        keywordHits: [],
        sessionCookieHeader,
        basicAuthHeader,
      };
    }

    // 3. Intentar CLI `lightpanda fetch --dump html <url>` (cuando no requiere login interactivo)
    if (!hasCredentials) {
      for (const bin of [this.binaryPath, 'lightpanda']) {
        try {
          const { stdout } = await execFileAsync(bin, ['fetch', '--dump', 'html', targetUrl], {
            timeout: 30000,
            maxBuffer: 15 * 1024 * 1024,
          });
          if (stdout && stdout.trim().length > 0) {
            const parsed = analyzeHtmlWithKeywords(stdout, targetUrl, keywords);

            // Si hubo Hits con enlaces a páginas de detalle y sin PDF directo, seguir hasta 3 páginas de detalle con Lightpanda CLI
            const extraTexts: string[] = [];
            const hitDocsCount = parsed.attachments.filter((a) => Boolean(a.matchedKeyword)).length;
            if (keywords.length > 0 && parsed.candidateDetailUrls.length > 0 && hitDocsCount === 0) {
              for (const candidate of parsed.candidateDetailUrls.slice(0, 3)) {
                try {
                  const subOut = await execFileAsync(bin, ['fetch', '--dump', 'html', candidate.url], {
                    timeout: 20000,
                    maxBuffer: 10 * 1024 * 1024,
                  });
                  if (subOut.stdout) {
                    const subParsed = analyzeHtmlWithKeywords(subOut.stdout, candidate.url, keywords);
                    if (subParsed.text) {
                      extraTexts.push(
                        `=== DETALLE DE LICITACIÓN DETECTADA POR HIT [${candidate.matchedKeywords.join(', ')}] (${candidate.url}) ===\n${subParsed.text}`
                      );
                    }
                    for (const subDoc of subParsed.attachments) {
                      if (!parsed.attachments.some((existing) => existing.url === subDoc.url)) {
                        parsed.attachments.unshift({
                          ...subDoc,
                          matchedKeyword: candidate.matchedKeywords.join(', '),
                          fromHitContext: candidate.snippet.slice(0, 140),
                        });
                      }
                      const matchingHit = parsed.keywordHits.find((h) => h.detailUrl === candidate.url);
                      if (matchingHit && !matchingHit.documentUrls.includes(subDoc.url)) {
                        matchingHit.documentUrls.push(subDoc.url);
                      }
                    }
                  }
                } catch {
                  // Ignorar error en subpágina
                }
              }
            }

            return {
              url: targetUrl,
              finalUrl: targetUrl,
              title: parsed.title,
              methodUsed: 'lightpanda_cli',
              authenticated: false,
              isDirectDocumentUrl: false,
              pageText: [parsed.text, ...extraTexts].filter(Boolean).join('\n\n'),
              attachments: parsed.attachments,
              keywordsSearched: keywords,
              keywordHits: parsed.keywordHits,
            };
          }
        } catch {
          // Intentar siguiente método
        }
      }
    }

    // 4. Fallback HTTP (con seguimiento de Hits de palabras clave en subpáginas)
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
      reqHeaders['Cookie'] = sessionCookieHeader;
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
        keywordsSearched: keywords,
        keywordHits: [],
        sessionCookieHeader,
        basicAuthHeader,
      };
    }

    const html = await res.text();
    const parsed = analyzeHtmlWithKeywords(html, finalUrl, keywords);

    // Seguir subpáginas de Hits si no había link directo al PDF en la tabla principal
    const extraTexts: string[] = [];
    const hitDocsCount = parsed.attachments.filter((a) => Boolean(a.matchedKeyword)).length;
    if (keywords.length > 0 && parsed.candidateDetailUrls.length > 0 && hitDocsCount === 0) {
      for (const candidate of parsed.candidateDetailUrls.slice(0, 3)) {
        try {
          const subRes = await fetch(candidate.url, {
            redirect: 'follow',
            headers: reqHeaders,
            signal: AbortSignal.timeout(15000),
          });
          if (subRes.ok) {
            const subCt = subRes.headers.get('content-type') || '';
            const subDocType = detectDocumentType(subRes.url || candidate.url, subCt);
            if (subDocType) {
              parsed.attachments.unshift({
                url: subRes.url || candidate.url,
                label: candidate.snippet.slice(0, 80) || 'Documento de licitación',
                fileType: subDocType,
                matchedKeyword: candidate.matchedKeywords.join(', '),
                fromHitContext: candidate.snippet.slice(0, 140),
              });
            } else {
              const subHtml = await subRes.text();
              const subParsed = analyzeHtmlWithKeywords(subHtml, subRes.url || candidate.url, keywords);
              if (subParsed.text) {
                extraTexts.push(
                  `=== DETALLE DE LICITACIÓN DETECTADA POR HIT [${candidate.matchedKeywords.join(', ')}] (${candidate.url}) ===\n${subParsed.text}`
                );
              }
              for (const subDoc of subParsed.attachments) {
                if (!parsed.attachments.some((existing) => existing.url === subDoc.url)) {
                  parsed.attachments.unshift({
                    ...subDoc,
                    matchedKeyword: candidate.matchedKeywords.join(', '),
                    fromHitContext: candidate.snippet.slice(0, 140),
                  });
                }
                const matchingHit = parsed.keywordHits.find((h) => h.detailUrl === candidate.url);
                if (matchingHit && !matchingHit.documentUrls.includes(subDoc.url)) {
                  matchingHit.documentUrls.push(subDoc.url);
                }
              }
            }
          }
        } catch {
          // Ignorar error en subpágina
        }
      }
    }

    return {
      url: targetUrl,
      finalUrl,
      title: parsed.title,
      methodUsed: 'http_fetch_fallback',
      authenticated: hasCredentials,
      isDirectDocumentUrl: false,
      pageText: [parsed.text, ...extraTexts].filter(Boolean).join('\n\n'),
      attachments: parsed.attachments,
      keywordsSearched: keywords,
      keywordHits: parsed.keywordHits,
      sessionCookieHeader,
      basicAuthHeader,
    };
  }

  /**
   * Si la página tiene un buscador interno y aún no hubo hits visibles, escribe la palabra clave y ejecuta la búsqueda.
   */
  private async tryPortalSearchInput(page: any, keyword: string): Promise<boolean> {
    try {
      const searched = await page.evaluate((kw: string) => {
        const searchInput = document.querySelector(
          'input[type="search"], input[name*="search" i], input[name*="buscar" i], input[name*="palabra" i], input[placeholder*="buscar" i], input[placeholder*="palabra" i], input[id*="search" i], input[id*="buscar" i]'
        ) as HTMLInputElement | null;

        if (!searchInput) return false;

        searchInput.focus();
        searchInput.value = kw;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));

        const form = searchInput.closest('form');
        if (form) {
          const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type="button"])') as HTMLElement | null;
          if (btn) {
            btn.click();
          } else {
            form.submit();
          }
        } else {
          searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }
        return true;
      }, keyword);

      if (searched) {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        return true;
      }
      return false;
    } catch {
      return false;
    }
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
