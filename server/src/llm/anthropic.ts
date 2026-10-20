// Anthropic Messages API over plain fetch. Also works with servers that mimic it (LM Studio's Anthropic mode).
import type { ResolvedBuiltin } from '../config.ts';
import { hostLabel, postJson } from './http.ts';
import { emptyUsage, LlmError, type ChatSession, type Provider, type SessionOptions } from './types.ts';

const API_VERSION = '2023-06-01';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: string; [k: string]: unknown }; // thinking and other blocks are passed back untouched
type Message = { role: 'user' | 'assistant'; content: string | Block[] };

export function anthropicProvider(cfg: ResolvedBuiltin): Provider {
  return {
    label: `${cfg.model} via Anthropic${/anthropic\.com/.test(cfg.baseUrl) ? '' : ` (${hostLabel(cfg.baseUrl)})`}`,
    open: (opts) => new AnthropicSession(cfg, opts),
  };
}

class AnthropicSession implements ChatSession {
  readonly usage = emptyUsage();
  private readonly messages: Message[] = [];
  private toolCallsLeft: number;

  constructor(
    private readonly cfg: ResolvedBuiltin,
    private readonly opts: SessionOptions,
  ) {
    this.toolCallsLeft = opts.maxToolCalls;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'anthropic-version': API_VERSION };
    if (this.cfg.apiKey) {
      h['x-api-key'] = this.cfg.apiKey;
      // Compatible servers (LM Studio) authenticate with a bearer token instead.
      if (!/anthropic\.com/.test(this.cfg.baseUrl)) h.authorization = `Bearer ${this.cfg.apiKey}`;
    }
    return h;
  }

  async ask(text: string): Promise<string> {
    this.messages.push({ role: 'user', content: text });
    for (let round = 0; round < this.opts.maxToolCalls + 4; round++) {
      const allowTools = this.toolCallsLeft > 0 && this.opts.tools.length > 0;
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        max_tokens: this.opts.maxOutputTokens,
        // The writer instructions are the same for every job: cache them.
        system: [{ type: 'text', text: this.opts.system, cache_control: { type: 'ephemeral' } }],
        messages: this.messages,
      };
      if (this.opts.tools.length) {
        body.tools = this.opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        body.tool_choice = { type: allowTools ? 'auto' : 'none' };
      }
      const res = await postJson(`${this.cfg.baseUrl}/messages`, this.headers(), body, this.opts);
      this.usage.requests++;
      const u = res.usage ?? {};
      this.usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      this.usage.cachedInputTokens += u.cache_read_input_tokens ?? 0;
      this.usage.outputTokens += u.output_tokens ?? 0;

      const content: Block[] = Array.isArray(res.content) ? res.content : [];
      this.messages.push({ role: 'assistant', content });
      const calls = content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (!calls.length) {
        if (res.stop_reason === 'max_tokens') throw new LlmError('The answer hit the output token limit', 'truncated');
        return content
          .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('');
      }
      this.messages.push({
        role: 'user',
        content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: this.runTool(c.name, c.input) })),
      });
    }
    throw new LlmError('The model kept calling tools instead of answering', 'transient');
  }

  private runTool(name: string, input: Record<string, unknown>): string {
    if (this.toolCallsLeft <= 0) return 'Tool budget used up. Answer now with the JSON object.';
    this.toolCallsLeft--;
    this.usage.toolCalls++;
    const tool = this.opts.tools.find((t) => t.name === name);
    if (!tool) return `Unknown tool "${name}".`;
    try {
      return tool.run(input ?? {});
    } catch (err) {
      return `Tool error: ${(err as Error).message}`;
    }
  }
}
