// The provider layer: what the built-in runner needs from a model API, independent of the wire protocol.
// Adapters (anthropic.ts, openai.ts) translate this to HTTP with plain fetch; no SDKs.

/** A tool the model may call while writing (search_events, show_event). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
  /** Runs the tool; the returned text goes back to the model. */
  run(args: Record<string, unknown>): string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (cheaper), when reported. */
  cachedInputTokens: number;
  requests: number;
  toolCalls: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, requests: 0, toolCalls: 0 });

export interface SessionOptions {
  /** The writer instructions. Sent as the system prompt (and cached where the provider supports it). */
  system: string;
  tools: ToolSpec[];
  /** After this many tool calls the model must answer without tools. */
  maxToolCalls: number;
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}

/** One conversation for one job: the brief, any tool calls, and repair rounds share it. */
export interface ChatSession {
  /**
   * Sends a user message, runs tool calls until the model answers in text, and returns that text. Given
   * several parts, every part but the last is a stable prefix that providers with explicit caching cache on
   * its own (shared across jobs); others just join the parts.
   */
  ask(text: string | string[]): Promise<string>;
  readonly usage: Usage;
}

export interface Provider {
  /** For the UI and logs, e.g. "google/gemma-4-e2b via OpenAI-compatible (localhost:1234)". */
  readonly label: string;
  open(opts: SessionOptions): ChatSession;
}

/**
 * A failed provider request. `kind` says what the runner should do:
 *   config    the key, model or URL is wrong: pause and put the job back (retrying cannot help)
 *   truncated the answer hit the output limit: ask again for a shorter reply
 *   transient network, timeout, 429, 5xx: already retried; fail this job
 *   aborted   the job was cancelled
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'truncated' | 'transient' | 'aborted',
    readonly status?: number,
  ) {
    super(message);
  }
}
