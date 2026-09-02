/**
 * BlobStore: read/write access for raw file bytes.
 *
 * Content-addressed: the key is the sha256 of the content. There is no
 * "path" idea in the interface — local disk is a flat directory keyed by
 * hash, and any key/value store could implement this later.
 *
 * The only implementation today is local disk (data/files/{sha256}).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface BlobStore {
  /** Idempotent write: a file that already exists under this hash is left alone. */
  put(sha256: string, bytes: Uint8Array): Promise<void>;
  get(sha256: string): Promise<Uint8Array>;
  exists(sha256: string): Promise<boolean>;
}

/** Local disk implementation: `{dir}/{sha256}`, flat. */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, sha256);
    if (!(await Bun.file(path).exists())) {
      await Bun.write(path, bytes);
    }
  }

  async get(sha256: string): Promise<Uint8Array> {
    const file = Bun.file(join(this.dir, sha256));
    return new Uint8Array(await file.arrayBuffer());
  }

  async exists(sha256: string): Promise<boolean> {
    return Bun.file(join(this.dir, sha256)).exists();
  }
}
