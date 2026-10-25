import { describe, expect, it } from 'vitest';
import { needsKey, PROVIDER_IDS, PROVIDERS, visionGuess } from '../../../src/shared/teammate/providers';

describe('providers', () => {
  it('lists every provider in the spec once', () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual([...PROVIDER_IDS].sort());
    const presets = PROVIDERS.filter((p) => p.id !== 'custom');
    const order = presets.map((p) => `${p.group === 'cloud' ? 0 : 1}${p.name.toLowerCase()}`);
    expect(order).toEqual([...order].sort());
    expect(PROVIDERS[PROVIDERS.length - 1].id).toBe('custom');
    for (const p of presets) expect(p.baseUrl).toMatch(/^https?:\/\/[^/]+/);
    expect(PROVIDERS.find((p) => p.id === 'custom')?.baseUrl).toBe('');
    expect(PROVIDERS.find((p) => p.id === 'anthropic')).toMatchObject({
      protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
    });
    expect(PROVIDERS.filter((p) => p.protocol === 'anthropic').map((p) => p.id)).toEqual(['anthropic']);
    const local = (id: string): unknown => PROVIDERS.find((p) => p.id === id);
    expect(local('ollama')).toMatchObject({ group: 'local', baseUrl: 'http://localhost:11434/v1' });
    expect(local('lmstudio')).toMatchObject({ group: 'local', baseUrl: 'http://localhost:1234/v1' });
  });

  it('does not call deepseek-chat text-only', () => {
    // DeepSeek's API models see images, and the same names carry over between versions.
    for (const m of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder', 'deepseek-r1', 'deepseek-v3']) {
      expect(visionGuess(m), m).toBeNull();
    }
  });

  it('guesses vision for known model names', () => {
    for (const m of [
      'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'claude-3-5-sonnet-20241022', 'claude-sonnet-4-5',
      'claude-opus-4-1', 'gemini-2.5-flash', 'qwen-vl-max', 'qwen2.5-vl-72b-instruct', 'qwen3-vl-plus',
      'doubao-1-5-vision-pro-32k', 'glm-4v-plus', 'glm-4.5v', 'moonshot-v1-8k-vision-preview', 'grok-2-vision-1212',
      'openai/gpt-4o', 'anthropic/claude-3.7-sonnet', 'llava:13b', 'o1', 'o3', 'o4-mini', 'gpt-4-1106-vision-preview',
    ]) {
      expect(visionGuess(m), m).toBe(true);
    }
    for (const m of [
      'gpt-3.5-turbo', 'o3-mini', 'o1-mini', 'o1-preview', 'claude-2.1', 'qwen-max',
      'qwen-plus', 'glm-4-plus', 'moonshot-v1-8k', 'kimi-k2-0905-preview', 'codestral-latest',
    ]) {
      expect(visionGuess(m), m).toBe(false);
    }
    // Unsure is null, never a wrong no.
    for (const m of [
      'my-local-model', 'deepseek-chat', 'deepseek-reasoner', 'mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'kimi-k2.5',
    ]) {
      expect(visionGuess(m), m).toBeNull();
    }
    expect(visionGuess('')).toBeNull();
  });
});

describe('needsKey', () => {
  it('lets local servers go without a key', () => {
    expect(needsKey({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1' })).toBe(false);
    expect(needsKey({ provider: 'lmstudio', baseUrl: 'http://192.168.1.5:1234/v1' })).toBe(false);
    for (const url of ['http://localhost:8080/v1', 'http://127.0.0.1:8080', 'http://[::1]:8080/v1']) {
      expect(needsKey({ provider: 'custom', baseUrl: url }), url).toBe(false);
    }
    for (const url of ['https://api.example.com/v1', 'http://localhost.example.com', 'not a url', '']) {
      expect(needsKey({ provider: 'custom', baseUrl: url }), url).toBe(true);
    }
    expect(needsKey({ provider: 'openai', baseUrl: 'http://localhost:8080/v1' })).toBe(true);
  });
});
