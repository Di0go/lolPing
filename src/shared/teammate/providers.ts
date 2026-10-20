export const PROVIDER_IDS = [
  'openai', 'anthropic', 'gemini', 'deepseek', 'qwen', 'doubao', 'kimi', 'glm', 'minimax', 'xai', 'mistral', 'openrouter',
  'ollama', 'lmstudio', 'custom',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderPreset {
  id: ProviderId;
  /** Brand name, the same in every language. */
  name: string;
  group: 'cloud' | 'local';
  protocol: 'openai' | 'anthropic';
  /** Editable in the profile; Custom starts empty. */
  baseUrl: string;
}

/** Grouped (cloud, local) and alphabetical, with Custom last. No provider is the default. */
export const PROVIDERS: readonly ProviderPreset[] = [
  { id: 'anthropic', name: 'Anthropic', group: 'cloud', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'deepseek', name: 'DeepSeek', group: 'cloud', protocol: 'openai', baseUrl: 'https://api.deepseek.com' },
  {
    id: 'doubao', name: 'Doubao', group: 'cloud', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  { id: 'glm', name: 'GLM', group: 'cloud', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  {
    id: 'gemini', name: 'Google Gemini', group: 'cloud', protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  { id: 'kimi', name: 'Kimi', group: 'cloud', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'minimax', name: 'MiniMax', group: 'cloud', protocol: 'openai', baseUrl: 'https://api.minimaxi.com/v1' },
  { id: 'mistral', name: 'Mistral', group: 'cloud', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'openai', name: 'OpenAI', group: 'cloud', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'openrouter', name: 'OpenRouter', group: 'cloud', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  {
    id: 'qwen', name: 'Qwen', group: 'cloud', protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  { id: 'xai', name: 'xAI', group: 'cloud', protocol: 'openai', baseUrl: 'https://api.x.ai/v1' },
  { id: 'lmstudio', name: 'LM Studio', group: 'local', protocol: 'openai', baseUrl: 'http://localhost:1234/v1' },
  { id: 'ollama', name: 'Ollama', group: 'local', protocol: 'openai', baseUrl: 'http://localhost:11434/v1' },
  { id: 'custom', name: 'Custom', group: 'cloud', protocol: 'openai', baseUrl: '' },
];

const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** Local servers take no key: Ollama and LM Studio always, and a Custom profile pointed at this computer. */
export function needsKey(p: { provider: ProviderId; baseUrl: string }): boolean {
  if (p.provider === 'ollama' || p.provider === 'lmstudio') return false;
  if (p.provider !== 'custom') return true;
  try {
    return !LOCAL_HOSTS.includes(new URL(p.baseUrl).hostname);
  } catch {
    return true;
  }
}

// First match wins, so the vision variants come before the text-only names they contain. A "no" is only for models
// known to refuse images; anything unsure stays unknown (null), because a wrong no silently drops the screenshot.
const VISION_PATTERNS: readonly [RegExp, boolean][] = [
  [/gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4.*vision|gpt-5/, true],
  [/(^|\/)o(1-mini|1-preview|3-mini)/, false],
  [/(^|\/)o(1|3|4)(-|$)/, true],
  [/claude-(3|[4-9]|(opus|sonnet|haiku)-[4-9])/, true],
  [/gemini|gemma-?3/, true],
  [/qwen.*-vl|qvq|qwen.*omni/, true],
  [/doubao.*vision|doubao-seed/, true],
  [/glm-\d(\.\d)?v/, true],
  [/(moonshot|kimi).*vision/, true],
  [/grok.*vision|grok-4/, true],
  [/llava|pixtral|minicpm-v|llama-?3\.2.*vision|llama-?4|deepseek-vl/, true],
  [/gpt-3\.5|gpt-4(-\d{4}|-32k)?$|claude-(2|instant)/, false],
  [/qwen-(max|plus|turbo|long|coder)|qwen3-(max|coder)|qwq/, false],
  [/glm-(4-|4\.[5-7](-|$)|z1)/, false],
  [/moonshot-v1-(\d+k|auto)$|kimi-k2(-|$)/, false],
  [/doubao-(1[-.]5-)?(pro|lite)/, false],
  [/grok-(2|3)(-|$)|grok-code|grok-beta/, false],
  [/codestral|minimax-m\d|abab/, false],
];

/** Whether a model can see images, from its name; null when the name is unknown (treated as yes until refused). */
export function visionGuess(model: string): boolean | null {
  const name = model.trim().toLowerCase();
  if (name === '') return null;
  for (const [pattern, vision] of VISION_PATTERNS) if (pattern.test(name)) return vision;
  return null;
}
