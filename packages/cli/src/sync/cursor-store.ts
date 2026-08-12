import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { syncCursorFilePath } from '../home.js';
import type { FileCursor, SourceType, TranscriptCursorStoreData } from './types.js';

export function getDefaultCursorFile(): string {
  return syncCursorFilePath();
}

export function cursorKey(sourceId: SourceType, filePath: string): string {
  return `${sourceId}:${filePath}`;
}

export function createEmptyFileCursor(): FileCursor {
  return {
    offset: 0,
    line: 0,
    importedCount: 0,
    skippedCount: 0,
    fileSize: 0,
    lastMtimeMs: 0,
  };
}

function emptyStore(): TranscriptCursorStoreData {
  return { version: 1, files: {} };
}

function isCursor(value: unknown): value is FileCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.offset === 'number' &&
    typeof record.line === 'number' &&
    typeof record.importedCount === 'number' &&
    typeof record.skippedCount === 'number' &&
    typeof record.fileSize === 'number' &&
    typeof record.lastMtimeMs === 'number' &&
    (record.sourceSha256 === undefined || typeof record.sourceSha256 === 'string') &&
    (record.contentId === undefined || typeof record.contentId === 'string')
  );
}

function parseStore(raw: string): TranscriptCursorStoreData {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyStore();
  }

  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
    return emptyStore();
  }

  const files: Record<string, FileCursor> = {};
  for (const [key, value] of Object.entries(record.files as Record<string, unknown>)) {
    if (isCursor(value)) files[key] = value;
  }
  return { version: 1, files };
}

export class CursorStore {
  private data: TranscriptCursorStoreData | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = getDefaultCursorFile()) {}

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<TranscriptCursorStoreData> {
    if (this.data) return this.data;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = parseStore(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.data = emptyStore();
    }
    return this.data;
  }

  async get(sourceId: SourceType, filePath: string): Promise<FileCursor> {
    const data = await this.load();
    return data.files[cursorKey(sourceId, filePath)] ?? createEmptyFileCursor();
  }

  async set(sourceId: SourceType, filePath: string, cursor: FileCursor): Promise<void> {
    const data = await this.load();
    data.files[cursorKey(sourceId, filePath)] = {
      ...cursor,
      updatedAt: new Date().toISOString(),
    };
  }

  async remove(sourceId: SourceType, filePath: string): Promise<void> {
    const data = await this.load();
    delete data.files[cursorKey(sourceId, filePath)];
  }

  async entries(): Promise<Array<{ key: string; cursor: FileCursor }>> {
    const data = await this.load();
    return Object.entries(data.files).map(([key, cursor]) => ({ key, cursor }));
  }

  async save(): Promise<void> {
    const save = async (): Promise<void> => {
      const data = await this.load();
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmpPath, this.filePath);
    };
    this.saveQueue = this.saveQueue.then(save, save);
    await this.saveQueue;
  }
}
