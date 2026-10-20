import { LlmError } from './types.ts';

const RETRIES = 3;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(new LlmError('Cancelled', 'aborted'))), { once: true });
  });

/** The provider's own error message, when its body has one. */
function errorText(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    const msg = j?.error?.message ?? j?.error ?? j?.message;
    if (typeof msg === 'string') return `HTTP ${status}: ${msg}`;
  } catch {
    // not JSON
  }
  return `HTTP ${status}: ${body.slice(0, 300) || 'no body'}`;
}

/**
 * POSTs JSON and returns the parsed response. Retries network errors, timeouts, 429 and 5xx with backoff
 * (honoring Retry-After). 400/401/403/404 are configuration problems and are not retried.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<any> {
  let last: LlmError | undefined;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (opts.signal.aborted) throw new LlmError('Cancelled', 'aborted');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]),
      });
    } catch (err) {
      if (opts.signal.aborted) throw new LlmError('Cancelled', 'aborted');
      const timedOut = (err as Error).name === 'TimeoutError';
      last = new LlmError(
        timedOut ? `No response within ${Math.round(opts.timeoutMs / 1000)}s` : `Cannot reach ${new URL(url).host}: ${(err as any).cause?.code ?? (err as Error).message}`,
        'transient',
      );
      if (attempt < RETRIES) await sleep(2000 * 2 ** attempt, opts.signal);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError(`Response was not JSON: ${text.slice(0, 200)}`, 'transient', res.status);
      }
    }
    const message = errorText(res.status, text);
    if (res.status === 429 || res.status >= 500) {
      last = new LlmError(message, 'transient', res.status);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt < RETRIES) await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt, opts.signal);
      continue;
    }
    // 400 (bad request: usually an unsupported parameter or model), 401/403 (key), 404 (model or URL).
    throw new LlmError(message, 'config', res.status);
  }
  throw last ?? new LlmError('Request failed', 'transient');
}

/** "localhost:1234" for local servers, the host otherwise: enough to tell endpoints apart in the UI. */
export const hostLabel = (baseUrl: string) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};
