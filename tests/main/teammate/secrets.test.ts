import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, SecretsUnavailableError, type Crypto } from '../../../src/main/teammate/secrets';

/** Reversible stand-in for safeStorage: XOR with a byte, and a refusal to decrypt foreign bytes. */
const fakeCrypto = (available = true): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
});
const file = () => join(mkdtempSync(join(tmpdir(), 'lolping-secrets-')), 'teammate', 'secrets');

describe('SecretStore', () => {
  it('round-trips a key and the instructions', async () => {
    const path = file();
    const store = new SecretStore(path, fakeCrypto());
    await store.setKey('p1', 'sk-abc');
    await store.setInstructions('call me captain');
    const again = new SecretStore(path, fakeCrypto());
    expect(again.key('p1')).toBe('sk-abc');
    expect(again.hasKey('p1')).toBe(true);
    expect(again.hasKey('p2')).toBe(false);
    expect(again.instructions()).toBe('call me captain');
    await again.deleteKey('p1');
    expect(new SecretStore(path, fakeCrypto()).key('p1')).toBeNull();
  });

  it('never writes the key in plain text', async () => {
    const path = file();
    const store = new SecretStore(path, fakeCrypto());
    await store.setKey('p1', 'sk-very-secret');
    await store.setInstructions('private words');
    const bytes = readFileSync(path).toString('latin1');
    expect(bytes).not.toContain('sk-very-secret');
    expect(bytes).not.toContain('private words');
  });

  it('reports unavailable instead of throwing', async () => {
    const store = new SecretStore(file(), fakeCrypto(false));
    expect(store.available()).toBe(false);
    expect(store.key('p1')).toBeNull();
    expect(store.instructions()).toBe('');
    await expect(store.setKey('p1', 'sk-x')).rejects.toBeInstanceOf(SecretsUnavailableError);
    await expect(store.setInstructions('x')).rejects.toBeInstanceOf(SecretsUnavailableError);
  });

  it('treats a corrupted file as empty', async () => {
    const path = file();
    const store = new SecretStore(path, fakeCrypto());
    await store.setKey('p1', 'sk-abc');
    writeFileSync(path, Buffer.from('not what we wrote'));
    const broken = new SecretStore(path, fakeCrypto());
    expect(broken.key('p1')).toBeNull();
    expect(broken.instructions()).toBe('');
    await broken.setKey('p2', 'sk-new');
    expect(new SecretStore(path, fakeCrypto()).key('p2')).toBe('sk-new');
  });

  it('cuts instructions to 2,000 characters', async () => {
    const path = file();
    const store = new SecretStore(path, fakeCrypto());
    await store.setInstructions('a'.repeat(2500));
    expect(store.instructions()).toHaveLength(2000);
    expect(new SecretStore(path, fakeCrypto()).instructions()).toHaveLength(2000);
  });
});
