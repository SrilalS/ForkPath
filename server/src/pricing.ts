// Claude API list prices, used to estimate what the Claude Code worker's tokens would cost on the API.
// On a Pro or Max plan the worker is not billed per token, so these are only an "API-equivalent" figure.
// Source: https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-18). Update when prices change.

/** USD per million tokens. */
interface Rates {
  input: number;
  output: number;
  write5m: number;
  write1h: number;
  read: number;
}

const r = (input: number, output: number, write5m: number, write1h: number, read: number): Rates => ({ input, output, write5m, write1h, read });

/** Keyed by model id prefix; the longest matching prefix wins, so dated ids (claude-opus-4-1-2025...) work. */
const PRICES: Record<string, Rates> = {
  'claude-fable-5-1': r(10, 50, 12.5, 20, 0.25),
  'claude-fable-5': r(10, 50, 12.5, 20, 1),
  'claude-mythos-5-1': r(10, 50, 12.5, 20, 0.25),
  'claude-mythos-5': r(10, 50, 12.5, 20, 1),
  'claude-opus-5-5': r(4, 20, 5, 8, 0.2),
  'claude-opus-5': r(5, 25, 6.25, 10, 0.5),
  'claude-opus-4-8': r(5, 25, 6.25, 10, 0.5),
  'claude-opus-4-7': r(5, 25, 6.25, 10, 0.5),
  'claude-opus-4-6': r(5, 25, 6.25, 10, 0.5),
  'claude-opus-4-5': r(5, 25, 6.25, 10, 0.5),
  'claude-opus-4-1': r(15, 75, 18.75, 30, 1.5),
  'claude-opus-4': r(15, 75, 18.75, 30, 1.5),
  'claude-sonnet-5-5': r(2, 10, 2.5, 4, 0.1),
  'claude-sonnet-5': r(2, 10, 2.5, 4, 0.2),
  'claude-sonnet-4': r(3, 15, 3.75, 6, 0.3), // 4, 4.5 and 4.6 share these prices
  'claude-haiku-5-5': r(0.1, 0.5, 0.125, 0.2, 0.01),
  'claude-haiku-4-5': r(1, 5, 1.25, 2, 0.1),
  'claude-3-5-haiku': r(0.8, 4, 1, 1.6, 0.08),
};

/** Haiku 5.5 charges more once a prompt passes 100k tokens. */
const LONG_PROMPT = 100_000;
const HAIKU_55_LONG = r(0.5, 2.5, 0.625, 1, 0.05);

/** One model reply as recorded in a Claude Code transcript. */
export interface ReplyUsage {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  /** Fast mode (priced at 2x). */
  fast?: boolean;
  /** US-only inference (priced at 1.1x). */
  usOnly?: boolean;
}

export function ratesFor(model: string): Rates | undefined {
  const id = model.toLowerCase();
  let best: string | undefined;
  for (const prefix of Object.keys(PRICES)) {
    if (id.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? PRICES[best] : undefined;
}

/** What one reply would cost on the Claude API, or undefined for a model without known prices. */
export function replyCostUsd(u: ReplyUsage): number | undefined {
  let rates = ratesFor(u.model);
  if (!rates) return undefined;
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
  if (rates === PRICES['claude-haiku-5-5'] && prompt > LONG_PROMPT) rates = HAIKU_55_LONG;
  const usd =
    (u.inputTokens * rates.input +
      u.outputTokens * rates.output +
      u.cacheWrite5mTokens * rates.write5m +
      u.cacheWrite1hTokens * rates.write1h +
      u.cacheReadTokens * rates.read) /
    1e6;
  return usd * (u.fast ? 2 : 1) * (u.usOnly ? 1.1 : 1);
}
