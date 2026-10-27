import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import { db } from '../../db/pool.js';
import { claudeService } from '../llm/claude.service.js';

const execFileAsync = promisify(execFile);

export interface ProcessedDocumentResult {
  fileName: string;
  sourceUrl: string;
  fileType: 'pdf' | 'docx' | 'doc';
  fileSizeBytes: number;
  localPath: string;
  extractionMethod:
    | 'surya_ocr'
    | 'tesseract_ocr'
    | 'vision_ocr'
    | 'surya_hybrid_pdf'
    | 'pdf_text_parser'
    | 'word_mammoth';
  pagesProcessed: number;
  extractedText: string;
}

/**
 * Descarga un archivo PDF o Word (.docx / .doc) desde una URL, lo almacena en ./data/documents
 * y lo procesa con OCR de imagen (Tesseract / Surya / Vision OCR) para PDFs escaneados o Mammoth para Word.
 */
export class DocumentProcessorService {
  private docsDir = path.resolve(process.cwd(), 'data', 'documents');
  private suryaScriptPath = path.resolve(process.cwd(), 'scripts', 'surya_extract.py');

  constructor() {
    fs.mkdirSync(this.docsDir, { recursive: true });
  }

  async downloadAndProcessDocument(
    fileUrl: string,
    fileType: 'pdf' | 'docx' | 'doc',
    ocrMode: 'auto' | 'forzar_surya' = 'auto',
    authHeaders?: { cookie?: string; authorization?: string }
  ): Promise<ProcessedDocumentResult> {
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Lightpanda/1.0 Chrome/124.0.0.0 Safari/537.36',
    };
    if (authHeaders?.cookie) {
      headers['Cookie'] = authHeaders.cookie;
    }
    if (authHeaders?.authorization) {
      headers['Authorization'] = authHeaders.authorization;
    }

    const res = await fetch(fileUrl, {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      throw new Error(`No se pudo descargar el documento (${res.status} ${res.statusText}): ${fileUrl}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let resolvedType: 'pdf' | 'docx' | 'doc' = fileType;
    const ctHeader = (res.headers.get('content-type') || '').toLowerCase();
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF') {
      resolvedType = 'pdf';
    } else if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      resolvedType = 'docx';
    } else if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf) {
      resolvedType = 'doc';
    } else if (ctHeader.includes('pdf')) {
      resolvedType = 'pdf';
    } else if (ctHeader.includes('word') || ctHeader.includes('officedocument')) {
      resolvedType = 'docx';
    }

    const disposition = res.headers.get('content-disposition') || '';
    const dispMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
    const rawName = dispMatch
      ? decodeURIComponent(dispMatch[1].trim())
      : decodeURIComponent((res.url || fileUrl).split('?')[0].split('/').pop() || `documento.${resolvedType}`);

    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalFileName = `${hash}_${safeName.endsWith(`.${resolvedType}`) ? safeName : `${safeName}.${resolvedType}`}`;
    const localPath = path.join(this.docsDir, finalFileName);

    fs.writeFileSync(localPath, buffer);

    // Caché de OCR: si este mismo archivo exacto (mismo hash SHA-256) ya fue procesado con éxito antes, reutilizar su texto OCR
    if (ocrMode === 'auto') {
      try {
        const cachedDoc = await db.query(
          `SELECT metodo_extraccion, paginas_procesadas, texto_extraido
           FROM tender_documents
           WHERE local_path = $1 AND LENGTH(texto_extraido) > 250
           ORDER BY id DESC LIMIT 1`,
          [localPath]
        );
        if (cachedDoc.rowCount && cachedDoc.rowCount > 0) {
          const row = cachedDoc.rows[0];
          return {
            fileName: rawName,
            sourceUrl: fileUrl,
            fileType: resolvedType,
            fileSizeBytes: buffer.length,
            localPath,
            extractionMethod: row.metodo_extraccion,
            pagesProcessed: Number(row.paginas_procesadas || 1),
            extractedText: row.texto_extraido,
          };
        }
      } catch {
        // Continuar con extracción normal
      }
    }

    if (resolvedType === 'docx' || resolvedType === 'doc') {
      return this.processWordDocument(localPath, rawName, fileUrl, resolvedType, buffer.length);
    }

    return this.processPdfWithOcr(localPath, rawName, fileUrl, buffer, ocrMode);
  }

  /**
   * Procesa un archivo PDF o Word directamente desde un Buffer en memoria (ej. adjunto de correo electrónico),
   * lo almacena en ./data/documents y ejecuta OCR / Mammoth.
   */
  async processDocumentBuffer(
    buffer: Buffer,
    rawFileName: string,
    sourceLabel: string,
    ocrMode: 'auto' | 'forzar_surya' = 'auto'
  ): Promise<ProcessedDocumentResult> {
    let resolvedType: 'pdf' | 'docx' | 'doc' = 'pdf';
    const lowerName = (rawFileName || '').toLowerCase();
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF') {
      resolvedType = 'pdf';
    } else if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      resolvedType = 'docx';
    } else if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf) {
      resolvedType = 'doc';
    } else if (lowerName.endsWith('.docx')) {
      resolvedType = 'docx';
    } else if (lowerName.endsWith('.doc')) {
      resolvedType = 'doc';
    }

    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const safeName = (rawFileName || `adjunto.${resolvedType}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalFileName = `${hash}_${safeName.endsWith(`.${resolvedType}`) ? safeName : `${safeName}.${resolvedType}`}`;
    const localPath = path.join(this.docsDir, finalFileName);

    fs.writeFileSync(localPath, buffer);

    if (ocrMode === 'auto') {
      try {
        const cachedDoc = await db.query(
          `SELECT metodo_extraccion, paginas_procesadas, texto_extraido
           FROM tender_documents
           WHERE local_path = $1 AND LENGTH(texto_extraido) > 250
           ORDER BY id DESC LIMIT 1`,
          [localPath]
        );
        if (cachedDoc.rowCount && cachedDoc.rowCount > 0) {
          const row = cachedDoc.rows[0];
          return {
            fileName: rawFileName,
            sourceUrl: sourceLabel,
            fileType: resolvedType,
            fileSizeBytes: buffer.length,
            localPath,
            extractionMethod: row.metodo_extraccion,
            pagesProcessed: Number(row.paginas_procesadas || 1),
            extractedText: row.texto_extraido,
          };
        }
      } catch {
        // Continuar
      }
    }

    if (resolvedType === 'docx' || resolvedType === 'doc') {
      return this.processWordDocument(localPath, rawFileName, sourceLabel, resolvedType, buffer.length);
    }

    return this.processPdfWithOcr(localPath, rawFileName, sourceLabel, buffer, ocrMode);
  }

  private async processWordDocument(
    localPath: string,
    fileName: string,
    sourceUrl: string,
    fileType: 'docx' | 'doc',
    fileSizeBytes: number
  ): Promise<ProcessedDocumentResult> {
    try {
      const result = await mammoth.extractRawText({ path: localPath });
      const text = (result.value || '').trim();
      return {
        fileName,
        sourceUrl,
        fileType,
        fileSizeBytes,
        localPath,
        extractionMethod: 'word_mammoth',
        pagesProcessed: Math.max(1, Math.ceil(text.length / 3000)),
        extractedText: text || '[Documento Word sin texto extraíble]',
      };
    } catch (err: any) {
      return {
        fileName,
        sourceUrl,
        fileType,
        fileSizeBytes,
        localPath,
        extractionMethod: 'word_mammoth',
        pagesProcessed: 1,
        extractedText: `[Error al extraer texto del archivo Word: ${err?.message || err}]`,
      };
    }
  }

  private async processPdfWithOcr(
    localPath: string,
    fileName: string,
    sourceUrl: string,
    buffer: Buffer,
    ocrMode: 'auto' | 'forzar_surya'
  ): Promise<ProcessedDocumentResult> {
    const pythonCandidates = [
      process.env.SURYA_PYTHON_BIN || process.env.SURYA_PYTHON_PATH || '/var/www/scrapalapa/.venv-surya/bin/python',
      'python3',
      'python',
    ];

    let renderedPagesB64: Array<{ page: number; media_type: 'image/jpeg'; data: string }> = [];
    let detectedPages = 1;
    let localExtractedText = '';
    let localMethod: ProcessedDocumentResult['extractionMethod'] = 'surya_hybrid_pdf';

    // 1. Ejecutar puente Python (pypdfium2 + Tesseract OCR + Surya OCR + renderizado de imágenes JPEG para PDFs escaneados)
    for (const pyBin of pythonCandidates) {
      try {
        const { stdout } = await execFileAsync(
          pyBin,
          [this.suryaScriptPath, localPath, '--mode', ocrMode],
          {
            timeout: 180000,
            maxBuffer: 35 * 1024 * 1024,
          }
        );
        const parsed = JSON.parse(stdout.trim());
        if (parsed && parsed.ok) {
          detectedPages = Number(parsed.pages || 1);
          if (Array.isArray(parsed.rendered_pages_b64) && parsed.rendered_pages_b64.length > 0) {
            renderedPagesB64 = parsed.rendered_pages_b64;
          }
          if (parsed.text && parsed.text.trim().length > 0) {
            localExtractedText = parsed.text.trim();
            localMethod =
              parsed.method === 'tesseract_ocr'
                ? 'tesseract_ocr'
                : parsed.method === 'surya_ocr'
                  ? 'surya_ocr'
                  : 'surya_hybrid_pdf';
          }
          break;
        }
      } catch {
        // Probar siguiente binario de Python
      }
    }

    // 2. Si el PDF está conformado por imágenes escaneadas (renderedPagesB64 > 0 o localExtractedText < 300 chars),
    // realizar OCR de imagen de alta precisión (Vision OCR sobre las páginas renderizadas)
    if (renderedPagesB64.length > 0 || localExtractedText.length < 300) {
      const visionOcrText = await claudeService.extractTextFromScannedImages({
        renderedPages: renderedPagesB64,
        pdfBufferFallback: buffer,
        fileName,
      });

      if (visionOcrText && visionOcrText.length > localExtractedText.length) {
        return {
          fileName,
          sourceUrl,
          fileType: 'pdf',
          fileSizeBytes: buffer.length,
          localPath,
          extractionMethod: 'vision_ocr',
          pagesProcessed: detectedPages,
          extractedText: visionOcrText,
        };
      }
    }

    if (localExtractedText.length > 0) {
      return {
        fileName,
        sourceUrl,
        fileType: 'pdf',
        fileSizeBytes: buffer.length,
        localPath,
        extractionMethod: localMethod,
        pagesProcessed: detectedPages,
        extractedText: localExtractedText,
      };
    }

    // 3. Fallback en Node.js con pdf-parse para PDFs con capa de texto cuando Python no está disponible
    try {
      const pdfParseModule: any = await import('pdf-parse');
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const data = await pdfParse(buffer);
      const parsedText = (data.text || '').trim();
      return {
        fileName,
        sourceUrl,
        fileType: 'pdf',
        fileSizeBytes: buffer.length,
        localPath,
        extractionMethod: 'pdf_text_parser',
        pagesProcessed: Number(data.numpages || detectedPages || 1),
        extractedText: parsedText,
      };
    } catch (err: any) {
      return {
        fileName,
        sourceUrl,
        fileType: 'pdf',
        fileSizeBytes: buffer.length,
        localPath,
        extractionMethod: 'pdf_text_parser',
        pagesProcessed: detectedPages,
        extractedText: '',
      };
    }
  }
}

export const documentProcessorService = new DocumentProcessorService();
