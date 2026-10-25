import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, SecretsUnavailableError, type Crypto } from '../../../src/main/teammate/secrets';

/** Reversible stand-in for safeStorage: XOR plus a marker, and it throws on bytes it did not produce. */
const MARK = Buffer.from('FAKE:');
const fakeCrypto = (available = true): Crypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.concat([MARK, Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a))]),
  decryptString: (b) => {
    if (!b.subarray(0, MARK.length).equals(MARK)) throw new Error('not encrypted by this keychain');
    return Buffer.from(b.subarray(MARK.length).map((x) => x ^ 0x5a)).toString('utf8');
  },
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
    await expect(store.deleteKey('p1')).rejects.toBeInstanceOf(SecretsUnavailableError);
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

  it('keeps the old value when a write fails', async () => {
    const path = file();
    const crypto = fakeCrypto();
    const store = new SecretStore(path, crypto);
    await store.setKey('p1', 'old');
    await store.setInstructions('old words');
    crypto.encryptString = () => {
      throw new Error('keychain locked');
    };
    await expect(store.setKey('p1', 'new')).rejects.toThrow('keychain locked');
    await expect(store.setInstructions('new words')).rejects.toThrow();
    await expect(store.deleteKey('p1')).rejects.toThrow();
    expect(store.key('p1')).toBe('old');
    expect(store.instructions()).toBe('old words');
    expect(new SecretStore(path, fakeCrypto()).key('p1')).toBe('old');
  });

  it('moves a file it could not read aside before the first write, so a failed decrypt loses nothing', async () => {
    const path = file();
    await new SecretStore(path, fakeCrypto()).setKey('p1', 'sk-abc');
    const before = readFileSync(path);
    // A keychain that refuses to decrypt (a denied macOS prompt) on start, and works again later.
    const crypto = fakeCrypto();
    const decrypt = crypto.decryptString;
    crypto.decryptString = () => {
      throw new Error('denied');
    };
    const store = new SecretStore(path, crypto, () => 1234);
    expect(store.key('p1')).toBeNull();
    await store.setKey('p2', 'sk-new');
    expect(readFileSync(`${path}.unreadable-1234`)).toEqual(before);
    crypto.decryptString = decrypt;
    expect(new SecretStore(path, fakeCrypto()).key('p2')).toBe('sk-new');
  });

  it('reads the file again before the first write, keeping its keys when the keychain works by then', async () => {
    const path = file();
    await new SecretStore(path, fakeCrypto()).setKey('p1', 'sk-abc');
    const crypto = fakeCrypto();
    const decrypt = crypto.decryptString;
    crypto.decryptString = () => {
      throw new Error('denied');
    };
    const store = new SecretStore(path, crypto);
    crypto.decryptString = decrypt;
    await store.setInstructions('words');
    const again = new SecretStore(path, fakeCrypto());
    expect(again.key('p1')).toBe('sk-abc');
    expect(again.instructions()).toBe('words');
    expect(readdirSync(dirname(path))).toEqual(['secrets']);
  });
});
