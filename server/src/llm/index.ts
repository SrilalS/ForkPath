import type { ResolvedBuiltin } from '../config.ts';
import { anthropicProvider } from './anthropic.ts';
import { openaiProvider } from './openai.ts';
import type { Provider } from './types.ts';

export * from './types.ts';

/** The adapter for the configured wire protocol. */
export function createProvider(cfg: ResolvedBuiltin): Provider {
  return cfg.provider === 'anthropic' ? anthropicProvider(cfg) : openaiProvider(cfg);
}
