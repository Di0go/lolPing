import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renameWithRetry } from '../settingsStore';

/** The slice of Electron's safeStorage the teammate needs; tests pass a fake. */
export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export const INSTRUCTIONS_MAX_CHARS = 2000;

/** Thrown by a write when the system keychain can't encrypt, so nothing is stored in plain text. */
export class SecretsUnavailableError extends Error {
  constructor() {
    super('Secure storage is not available on this system');
    this.name = 'SecretsUnavailableError';
  }
}

interface SecretData {
  keys: Record<string, string>;
  instructions: string;
}

const EMPTY = (): SecretData => ({ keys: {}, instructions: '' });

/** Parses untrusted decrypted text; anything unexpected becomes an empty store. */
function parse(text: string): SecretData {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return EMPTY();
    const { keys, instructions } = raw as Record<string, unknown>;
    const out = EMPTY();
    if (typeof keys === 'object' && keys !== null) {
      for (const [id, value] of Object.entries(keys)) if (typeof value === 'string' && value) out.keys[id] = value;
    }
    if (typeof instructions === 'string') out.instructions = instructions.slice(0, INSTRUCTIONS_MAX_CHARS);
    return out;
  } catch {
    return EMPTY();
  }
}

/** Provider keys and "Your instructions", kept in one file encrypted as a whole through the system keychain. */
export class SecretStore {
  private data: SecretData = EMPTY();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly crypto: Crypto) {
    this.load();
  }

  available(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  key(profileId: string): string | null {
    if (!this.available()) return null;
    return Object.hasOwn(this.data.keys, profileId) ? this.data.keys[profileId] : null;
  }

  hasKey(profileId: string): boolean {
    return this.key(profileId) !== null;
  }

  async setKey(profileId: string, key: string): Promise<void> {
    await this.update((d) => {
      if (key) d.keys[profileId] = key;
      else delete d.keys[profileId];
    });
  }

  async deleteKey(profileId: string): Promise<void> {
    await this.update((d) => {
      delete d.keys[profileId];
    });
  }

  instructions(): string {
    return this.available() ? this.data.instructions : '';
  }

  async setInstructions(text: string): Promise<void> {
    await this.update((d) => {
      d.instructions = text.slice(0, INSTRUCTIONS_MAX_CHARS);
    });
  }

  private load(): void {
    // A missing, undecryptable or malformed file all mean "nothing stored yet"; the next write replaces it.
    if (!this.available() || !existsSync(this.file)) return;
    try {
      this.data = parse(this.crypto.decryptString(readFileSync(this.file)));
    } catch {
      this.data = EMPTY();
    }
  }

  private update(change: (d: SecretData) => void): Promise<void> {
    if (!this.available()) return Promise.reject(new SecretsUnavailableError());
    const next: SecretData = { keys: { ...this.data.keys }, instructions: this.data.instructions };
    change(next);
    this.data = next;
    const run = this.writing.then(() => this.write(next));
    this.writing = run.catch(() => undefined);
    return run;
  }

  private async write(d: SecretData): Promise<void> {
    const bytes = this.crypto.encryptString(JSON.stringify(d));
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await renameWithRetry(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
