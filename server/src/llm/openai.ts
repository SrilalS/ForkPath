// OpenAI Chat Completions over plain fetch. The de-facto standard protocol: OpenAI, Google Gemini
// (/v1beta/openai), OpenRouter, Groq, DeepSeek, Mistral, xAI, and local servers (Ollama, LM Studio, vLLM).
import type { ResolvedBuiltin } from '../config.ts';
import { hostLabel, postJson } from './http.ts';
import { emptyUsage, LlmError, type ChatSession, type Provider, type SessionOptions } from './types.ts';

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export function openaiProvider(cfg: ResolvedBuiltin): Provider {
  const official = /(^|\.)openai\.com$/.test(hostLabel(cfg.baseUrl).split(':')[0]);
  return {
    label: `${cfg.model} via OpenAI-compatible (${hostLabel(cfg.baseUrl)})`,
    open: (opts) => new OpenAISession(cfg, opts, official),
  };
}

class OpenAISession implements ChatSession {
  readonly usage = emptyUsage();
  private readonly messages: Message[];
  private toolCallsLeft: number;

  constructor(
    private readonly cfg: ResolvedBuiltin,
    private readonly opts: SessionOptions,
    /** api.openai.com wants max_completion_tokens; most compatible servers only know max_tokens. */
    private readonly official: boolean,
  ) {
    this.messages = [{ role: 'system', content: opts.system }];
    this.toolCallsLeft = opts.maxToolCalls;
  }

  async ask(text: string | string[]): Promise<string> {
    // OpenAI-style servers cache matching prefixes on their own, so the stable parts just go first.
    this.messages.push({ role: 'user', content: Array.isArray(text) ? text.join('\n\n') : text });
    // Bounded: each round either answers or spends tool calls; a model that ignores tool_choice gets cut off.
    for (let round = 0; round < this.opts.maxToolCalls + 4; round++) {
      const allowTools = this.toolCallsLeft > 0 && this.opts.tools.length > 0;
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages: this.messages,
        [this.official ? 'max_completion_tokens' : 'max_tokens']: this.opts.maxOutputTokens,
      };
      if (this.opts.tools.length) {
        body.tools = this.opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        body.tool_choice = allowTools ? 'auto' : 'none';
      }
      const headers: Record<string, string> = this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
      const res = await postJson(`${this.cfg.baseUrl}/chat/completions`, headers, body, this.opts);
      this.usage.requests++;
      this.usage.inputTokens += res.usage?.prompt_tokens ?? 0;
      this.usage.outputTokens += res.usage?.completion_tokens ?? 0;
      this.usage.cachedInputTokens += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      const choice = res.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new LlmError(`No message in response: ${JSON.stringify(res).slice(0, 200)}`, 'transient');
      const calls: ToolCall[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      this.messages.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });

      if (!calls.length) {
        const out = typeof msg.content === 'string' ? msg.content : '';
        if (choice.finish_reason === 'length') throw new LlmError('The answer hit the output token limit', 'truncated');
        return out;
      }
      for (const call of calls) {
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: this.runTool(call) });
      }
    }
    throw new LlmError('The model kept calling tools instead of answering', 'transient');
  }

  private runTool(call: ToolCall): string {
    if (this.toolCallsLeft <= 0) return 'Tool budget used up. Answer now with the JSON object.';
    this.toolCallsLeft--;
    this.usage.toolCalls++;
    const tool = this.opts.tools.find((t) => t.name === call.function?.name);
    if (!tool) return `Unknown tool "${call.function?.name}".`;
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return 'The arguments were not valid JSON.';
    }
    try {
      return tool.run(args);
    } catch (err) {
      return `Tool error: ${(err as Error).message}`;
    }
  }
}
