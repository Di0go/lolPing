export const PROVIDER_IDS = [
  'openai', 'anthropic', 'gemini', 'deepseek', 'qwen', 'doubao', 'kimi', 'glm', 'minimax', 'xai', 'mistral', 'openrouter',
  'ollama', 'lmstudio', 'custom',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
