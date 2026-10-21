import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';

const execFileAsync = promisify(execFile);

export interface ProcessedDocumentResult {
  fileName: string;
  sourceUrl: string;
  fileType: 'pdf' | 'docx' | 'doc';
  fileSizeBytes: number;
  localPath: string;
  extractionMethod: 'surya_ocr' | 'surya_hybrid_pdf' | 'pdf_text_parser' | 'word_mammoth';
  pagesProcessed: number;
  extractedText: string;
}

/**
 * Descarga un archivo PDF o Word (.docx / .doc) desde una URL, lo almacena en ./data/documents
 * y lo procesa con Surya OCR (para PDF) o Mammoth (para Word).
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

    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const rawName = decodeURIComponent(fileUrl.split('?')[0].split('/').pop() || `documento.${fileType}`);
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalFileName = `${hash}_${safeName.endsWith(`.${fileType}`) ? safeName : `${safeName}.${fileType}`}`;
    const localPath = path.join(this.docsDir, finalFileName);

    fs.writeFileSync(localPath, buffer);

    if (fileType === 'docx' || fileType === 'doc') {
      return this.processWordDocument(localPath, rawName, fileUrl, fileType, buffer.length);
    }

    return this.processPdfWithSurya(localPath, rawName, fileUrl, buffer, ocrMode);
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

  private async processPdfWithSurya(
    localPath: string,
    fileName: string,
    sourceUrl: string,
    buffer: Buffer,
    ocrMode: 'auto' | 'forzar_surya'
  ): Promise<ProcessedDocumentResult> {
    // 1. Intentar primero el puente Python de Surya OCR (scripts/surya_extract.py)
    const pythonCandidates = [
      process.env.SURYA_PYTHON_BIN || process.env.SURYA_PYTHON_PATH || '/var/www/scrapalapa/.venv-surya/bin/python',
      'python3',
      'python',
    ];

    for (const pyBin of pythonCandidates) {
      try {
        const { stdout } = await execFileAsync(
          pyBin,
          [this.suryaScriptPath, localPath, '--mode', ocrMode],
          {
            timeout: 180000,
            maxBuffer: 25 * 1024 * 1024,
          }
        );
        const parsed = JSON.parse(stdout.trim());
        if (parsed && parsed.ok && parsed.text && parsed.text.length > 0) {
          return {
            fileName,
            sourceUrl,
            fileType: 'pdf',
            fileSizeBytes: buffer.length,
            localPath,
            extractionMethod: parsed.method === 'surya_ocr' ? 'surya_ocr' : 'surya_hybrid_pdf',
            pagesProcessed: Number(parsed.pages || 1),
            extractedText: parsed.text,
          };
        }
      } catch {
        // Si el binario de Python/Surya no está disponible en este candidato, probar el siguiente o usar parser Node
      }
    }

    // 2. Fallback en Node.js con pdf-parse para extracción directa de PDF
    try {
      const pdfParseModule: any = await import('pdf-parse');
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const data = await pdfParse(buffer);
      return {
        fileName,
        sourceUrl,
        fileType: 'pdf',
        fileSizeBytes: buffer.length,
        localPath,
        extractionMethod: 'pdf_text_parser',
        pagesProcessed: Number(data.numpages || 1),
        extractedText: (data.text || '').trim(),
      };
    } catch (err: any) {
      return {
        fileName,
        sourceUrl,
        fileType: 'pdf',
        fileSizeBytes: buffer.length,
        localPath,
        extractionMethod: 'pdf_text_parser',
        pagesProcessed: 1,
        extractedText: `[No se pudo extraer texto del PDF (${err?.message || err}). Instala Surya OCR en el servidor para OCR de imágenes.]`,
      };
    }
  }
}

export const documentProcessorService = new DocumentProcessorService();
