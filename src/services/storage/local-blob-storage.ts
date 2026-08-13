import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface StoredBlob {
  readonly storageKey: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export class LocalBlobStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root, 'blobs');
  }

  private resolveKey(storageKey: string): string {
    if (isAbsolute(storageKey) || storageKey.split(/[\\/]/).includes('..')) {
      throw new Error('Invalid blob storage key');
    }
    const absolute = resolve(this.root, storageKey);
    const inside = relative(this.root, absolute);
    if (inside.startsWith(`..${sep}`) || inside === '..') throw new Error('Invalid blob storage key');
    return absolute;
  }

  async write(input: {
    readonly tenantId: string;
    readonly contentId: string;
    readonly data: Buffer;
  }): Promise<StoredBlob> {
    const storageKey = `${input.tenantId}/${input.contentId}/${randomUUID()}.blob`;
    const absolute = this.resolveKey(storageKey);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    await writeFile(absolute, input.data, { flag: 'wx', mode: 0o600 });
    return {
      storageKey,
      byteSize: input.data.byteLength,
      sha256: createHash('sha256').update(input.data).digest('hex'),
    };
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.resolveKey(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    await unlink(this.resolveKey(storageKey));
  }
}
