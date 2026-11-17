export interface DocumentProgressItem {
  id?: number;
  fileName: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  stage?: string;
  pagesProcessed?: number;
  totalPages?: number;
  method?: string;
  sizeKb?: number;
}

export interface TaskProgress {
  procedureId: string | number;
  tenderId: number;
  status: 'idle' | 'running' | 'completed' | 'error';
  action: 'synthesis' | 'timeline' | 'ingest';
  percent: number;
  currentStage: string;
  detailMessage: string;
  currentDocName?: string;
  documents: DocumentProgressItem[];
  startedAt: number;
  updatedAt: number;
  error?: string;
}

class TenderProgressService {
  private progressMap = new Map<string, TaskProgress>();

  startTask(
    procedureId: string | number,
    tenderId: number,
    action: 'synthesis' | 'timeline' | 'ingest',
    initialDocs: DocumentProgressItem[] = []
  ): TaskProgress {
    const key = String(procedureId);
    const progress: TaskProgress = {
      procedureId,
      tenderId,
      status: 'running',
      action,
      percent: 10,
      currentStage: 'Iniciando procesamiento...',
      detailMessage: 'Preparando análisis documental...',
      documents: initialDocs,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.progressMap.set(key, progress);
    return progress;
  }

  updateProgress(
    procedureId: string | number,
    update: Partial<TaskProgress> & {
      docUpdate?: {
        fileName: string;
        status?: DocumentProgressItem['status'];
        stage?: string;
        pagesProcessed?: number;
      };
    }
  ): TaskProgress | undefined {
    const key = String(procedureId);
    const existing = this.progressMap.get(key);
    if (!existing) return undefined;

    if (update.percent !== undefined) existing.percent = update.percent;
    if (update.status !== undefined) existing.status = update.status;
    if (update.currentStage !== undefined) existing.currentStage = update.currentStage;
    if (update.detailMessage !== undefined) existing.detailMessage = update.detailMessage;
    if (update.currentDocName !== undefined) existing.currentDocName = update.currentDocName;
    if (update.error !== undefined) existing.error = update.error;
    if (update.documents !== undefined) existing.documents = update.documents;

    if (update.docUpdate) {
      const { fileName, status, stage, pagesProcessed } = update.docUpdate;
      const doc = existing.documents.find((d) => d.fileName === fileName);
      if (doc) {
        if (status) doc.status = status;
        if (stage) doc.stage = stage;
        if (pagesProcessed !== undefined) doc.pagesProcessed = pagesProcessed;
      }
    }

    existing.updatedAt = Date.now();
    return existing;
  }

  completeTask(procedureId: string | number, message = '¡Proceso completado con éxito!'): void {
    const key = String(procedureId);
    const existing = this.progressMap.get(key);
    if (existing) {
      existing.status = 'completed';
      existing.percent = 100;
      existing.currentStage = message;
      existing.detailMessage = 'Datos guardados y sincronizados correctamente en la base de datos.';
      existing.documents.forEach((d) => {
        if (d.status === 'processing') d.status = 'completed';
      });
      existing.updatedAt = Date.now();
      setTimeout(() => this.progressMap.delete(key), 120000);
    }
  }

  failTask(procedureId: string | number, error: string): void {
    const key = String(procedureId);
    const existing = this.progressMap.get(key);
    if (existing) {
      existing.status = 'error';
      existing.currentStage = 'Error en el procesamiento';
      existing.detailMessage = error;
      existing.error = error;
      existing.updatedAt = Date.now();
      setTimeout(() => this.progressMap.delete(key), 60000);
    }
  }

  getProgress(procedureId: string | number): TaskProgress | null {
    const key = String(procedureId);
    return this.progressMap.get(key) || null;
  }
}

export const tenderProgressService = new TenderProgressService();
