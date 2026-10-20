// Connection checks for the Settings page: list a provider's models, and run one tiny request end to end.
import type { ResolvedBuiltin } from '../config.ts';
import { createProvider } from './index.ts';
import { extractJson } from './json.ts';
import { LlmError } from './types.ts';

function authHeaders(cfg: ResolvedBuiltin): Record<string, string> {
  if (!cfg.apiKey) return cfg.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {};
  if (cfg.provider === 'anthropic') {
    const h: Record<string, string> = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
    if (!/anthropic\.com/.test(cfg.baseUrl)) h.authorization = `Bearer ${cfg.apiKey}`;
    return h;
  }
  return { authorization: `Bearer ${cfg.apiKey}` };
}

/** Model ids the endpoint offers (GET /models, which both protocols have). */
export async function listModels(cfg: ResolvedBuiltin): Promise<string[]> {
  const res = await fetch(`${cfg.baseUrl}/models${cfg.provider === 'anthropic' ? '?limit=100' : ''}`, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw new Error(`Cannot reach ${cfg.baseUrl}: ${err.cause?.code ?? err.message}`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text)?.data;
  return Array.isArray(data) ? data.map((m: { id?: string }) => String(m.id ?? '')).filter(Boolean).sort() : [];
}

export interface ProbeResult {
  ok: boolean;
  label: string;
  ms: number;
  /** What the model said (trimmed), or the error. */
  detail: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** One short request with the real adapter: proves the URL, key, model and JSON replies all work. */
export async function probe(cfg: ResolvedBuiltin): Promise<ProbeResult> {
  const provider = createProvider(cfg);
  const started = Date.now();
  const session = provider.open({
    system: 'You reply with JSON only.',
    tools: [],
    maxToolCalls: 0,
    // Generous: thinking models spend part of the budget on hidden reasoning.
    maxOutputTokens: 2000,
    timeoutMs: Math.min(cfg.timeoutMs, 180_000),
    signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 180_000) + 5_000),
  });
  try {
    const reply = await session.ask('Reply with exactly {"ok": true} and nothing else.');
    let detail = reply.trim().slice(0, 200);
    let ok = true;
    try {
      ok = (extractJson(reply) as { ok?: unknown })?.ok === true;
      if (!ok) detail = `Unexpected reply: ${detail}`;
    } catch {
      ok = false;
      detail = `Reply was not JSON: ${detail}`;
    }
    return { ok, label: provider.label, ms: Date.now() - started, detail, inputTokens: session.usage.inputTokens, outputTokens: session.usage.outputTokens };
  } catch (err) {
    const msg = err instanceof LlmError ? err.message : (err as Error).message;
    return { ok: false, label: provider.label, ms: Date.now() - started, detail: msg };
  }
}
