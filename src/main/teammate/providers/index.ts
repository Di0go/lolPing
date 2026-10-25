import type { BuiltinProfile } from '../../../shared/teammate/settings';
import { anthropicAdapter } from './anthropic';
import { openaiCompatAdapter } from './openaiCompat';
import type { ProviderAdapter } from './types';

/** The adapter for a built-in profile's protocol, holding its key. */
export function createAdapter(p: BuiltinProfile, key: string, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return p.protocol === 'anthropic' ? anthropicAdapter(p, key, fetchImpl) : openaiCompatAdapter(p, key, fetchImpl);
}
