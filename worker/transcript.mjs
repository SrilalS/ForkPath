// Reads what a Claude Code session spent on one job, from the transcripts Claude Code keeps on disk:
//   <config>/projects/<project>/<session>.jsonl                      the session itself (the dispatcher)
//   <config>/projects/<project>/<session>/subagents/agent-*.jsonl    each subagent it spawned (the writers)
// A file counts from the line where the job id first appears (when next.mjs handed it out, or the writer
// was given it) to its end. The format is Claude Code's own and may change, so anything unexpected is skipped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The files to read for this session: the transcript, plus its subagents' transcripts. */
function transcriptFiles(sessionId, configDir) {
  const projects = path.join(configDir, 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return [];
  }
  for (const d of dirs) {
    const main = path.join(projects, d, `${sessionId}.jsonl`);
    if (!fs.existsSync(main)) continue;
    const subDir = path.join(projects, d, sessionId, 'subagents');
    let subs = [];
    try {
      subs = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(subDir, f));
    } catch {
      // No subagents.
    }
    return [main, ...subs];
  }
  return [];
}

/** One reply's usage in the shape the app's /usage route takes, or null for anything that is not a model reply. */
function replyOf(entry) {
  const msg = entry?.type === 'assistant' ? entry.message : null;
  const u = msg?.usage;
  // Synthetic entries ("<synthetic>") are Claude Code's own notes, not model calls.
  if (!u || !msg.id || typeof msg.model !== 'string' || msg.model.startsWith('<')) return null;
  const writes = u.cache_creation;
  return {
    model: msg.model,
    inputTokens: u.input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: writes ? (writes.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0),
    cacheWrite1hTokens: writes ? (writes.ephemeral_1h_input_tokens ?? 0) : 0,
    outputTokens: u.output_tokens ?? 0,
    ...(u.speed === 'fast' && { fast: true }),
    ...(u.inference_geo === 'us' && { usOnly: true }),
  };
}

/**
 * The model replies spent on job `jobId`, or null when there is nothing to report (not running in Claude
 * Code, no transcript, or the id never appears).
 */
export function repliesForJob(jobId, { sessionId = process.env.CLAUDE_CODE_SESSION_ID, configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude') } = {}) {
  if (!sessionId || !jobId) return null;
  // One reply is logged once per content block, all with the same message id and usage: count it once.
  const replies = new Map();
  for (const file of transcriptFiles(sessionId, configDir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const start = text.indexOf(jobId);
    if (start < 0) continue;
    const lineStart = text.lastIndexOf('\n', start) + 1;
    for (const line of text.slice(lineStart).split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = replyOf(entry);
      if (reply) replies.set(entry.message.id, reply);
    }
  }
  return replies.size ? [...replies.values()] : null;
}
