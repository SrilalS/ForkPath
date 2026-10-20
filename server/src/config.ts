// Which engine generates jobs: the external worker (a Claude Code session polling the worker API) or the
// built-in runner (this server calling a model API directly). Stored in data/config.json, which is
// gitignored because it can hold an API key. Edits to the file take effect without a restart.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR, writeJsonAtomic } from './store.ts';

export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const PROVIDERS = ['anthropic', 'openai-compatible'] as const;
export const REASONING_EFFORTS = ['default', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ProviderId = (typeof PROVIDERS)[number];

const builtinSchema = z.object({
  /** Wire protocol: Anthropic Messages, or OpenAI Chat Completions (OpenAI, Gemini, OpenRouter, Ollama, ...). */
  provider: z.enum(PROVIDERS).default('anthropic'),
  model: z.string().trim().default(''),
  /** API root. Defaults: https://api.anthropic.com/v1 and https://api.openai.com/v1. */
  baseUrl: z.string().trim().optional(),
  /** The key itself (kept in this gitignored file), or leave it out and use apiKeyEnv. */
  apiKey: z.string().trim().optional(),
  /** Environment variable holding the key. Defaults: ANTHROPIC_API_KEY / OPENAI_API_KEY. */
  apiKeyEnv: z.string().trim().optional(),
  /** Jobs generated at the same time. */
  concurrency: z.number().int().min(1).max(8).default(3),
  maxOutputTokens: z.number().int().min(1000).max(64000).default(8000),
  /** Search / show-event calls the model may make per job. */
  maxToolCalls: z.number().int().min(0).max(10).default(4),
  /** Times a result that fails validation is sent back for fixing before the job fails. */
  maxRepairs: z.number().int().min(0).max(5).default(2),
  /** Per request to the provider. */
  timeoutMs: z.number().int().min(10_000).max(900_000).default(300_000),
  /**
   * How hard reasoning models think. 'default' sends nothing (the model decides). OpenAI-compatible: sent
   * as reasoning_effort (OpenRouter: reasoning.effort). Anthropic: turns on extended thinking with a budget.
   */
  reasoningEffort: z.enum(REASONING_EFFORTS).default('default'),
  /** USD per million tokens, from the provider's price page. Without them, cost is unknown (tokens still count). */
  pricing: z
    .object({
      inputPerMTok: z.number().min(0).optional(),
      outputPerMTok: z.number().min(0).optional(),
      /** Input served from the prompt cache; defaults to the input price. */
      cachedInputPerMTok: z.number().min(0).optional(),
    })
    .default({}),
});

const configSchema = z.object({
  engine: z.enum(['external', 'builtin']).default('external'),
  builtin: builtinSchema.default(builtinSchema.parse({})),
  /** Spending cap for the built-in engine, per calendar month (UTC). Needs pricing to mean anything. */
  budget: z.object({ monthlyUsd: z.number().min(0).optional() }).default({}),
});

export type BuiltinConfig = z.infer<typeof builtinSchema>;
export type AppConfig = z.infer<typeof configSchema>;

const DEFAULT_BASE: Record<ProviderId, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
};
const DEFAULT_KEY_ENV: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

function read(): AppConfig {
  try {
    return configSchema.parse(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[config] ignoring invalid data/config.json:', err);
    return configSchema.parse({});
  }
}

let current = read();
const listeners = new Set<(c: AppConfig) => void>();

export const getConfig = () => current;

export function onConfigChange(fn: (c: AppConfig) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(current);
}

/**
 * Merges `patch` into the stored config. An apiKey of '' removes the stored key; a pricing or budget field
 * of null clears it.
 */
export function updateConfig(patch: {
  engine?: AppConfig['engine'];
  builtin?: Partial<Omit<BuiltinConfig, 'pricing'>> & { pricing?: Record<string, number | null | undefined> };
  budget?: { monthlyUsd?: number | null };
}): AppConfig {
  const pricing = dropNulls({ ...current.builtin.pricing, ...patch.builtin?.pricing });
  const builtin = { ...current.builtin, ...patch.builtin, pricing };
  if (builtin.apiKey === '') delete builtin.apiKey;
  const budget = dropNulls({ ...current.budget, ...patch.budget });
  current = configSchema.parse({ engine: patch.engine ?? current.engine, builtin, budget });
  writeJsonAtomic(CONFIG_FILE, current);
  emit();
  return current;
}

const dropNulls = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as { [K in keyof T]: Exclude<T[K], null> };

/** Cost of a job in USD, or undefined when no prices are configured. */
export function costUsd(u: { inputTokens: number; outputTokens: number; cachedInputTokens: number }, p = current.builtin.pricing) {
  if (p.inputPerMTok === undefined && p.outputPerMTok === undefined) return undefined;
  const input = p.inputPerMTok ?? 0;
  const cached = p.cachedInputPerMTok ?? input;
  return ((u.inputTokens - u.cachedInputTokens) * input + u.cachedInputTokens * cached + u.outputTokens * (p.outputPerMTok ?? 0)) / 1e6;
}

// Hand edits to the file apply live. unref: the watcher alone never keeps the process running.
fs.watchFile(CONFIG_FILE, { interval: 1000 }, () => {
  const next = read();
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  emit();
}).unref();

/** Everything a provider needs, with defaults filled in. Never sent to the browser. */
export function resolveBuiltin(c: BuiltinConfig = current.builtin) {
  const keyEnv = c.apiKeyEnv || DEFAULT_KEY_ENV[c.provider];
  return {
    ...c,
    baseUrl: (c.baseUrl || DEFAULT_BASE[c.provider]).replace(/\/+$/, ''),
    apiKey: c.apiKey || process.env[keyEnv] || '',
    keyEnv,
  };
}
export type ResolvedBuiltin = ReturnType<typeof resolveBuiltin>;

/** Why the built-in runner cannot run with this config, or null when it can. */
export function builtinProblem(r: ResolvedBuiltin = resolveBuiltin()): string | null {
  if (!r.model) return 'No model set';
  // Local OpenAI-compatible servers (Ollama, LM Studio, vLLM) usually need no key.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(r.baseUrl);
  if (!r.apiKey && !local) return `No API key (set apiKey in data/config.json or the ${r.keyEnv} environment variable)`;
  return null;
}

/** Safe to show in the UI: no key. */
export function publicConfig() {
  const r = resolveBuiltin();
  return {
    engine: current.engine,
    builtin: {
      provider: r.provider,
      model: r.model,
      baseUrl: r.baseUrl,
      hasKey: Boolean(r.apiKey),
      keySource: current.builtin.apiKey ? 'config' : r.apiKey ? `env:${r.keyEnv}` : 'none',
      concurrency: r.concurrency,
      maxOutputTokens: r.maxOutputTokens,
      maxToolCalls: r.maxToolCalls,
      maxRepairs: r.maxRepairs,
      timeoutMs: r.timeoutMs,
      reasoningEffort: r.reasoningEffort,
      pricing: r.pricing,
    },
    budget: current.budget,
    problem: current.engine === 'builtin' ? builtinProblem(r) : null,
  };
}
