import { z } from 'zod';
import { SIGNIFICANCES, STRENGTHS, TONES } from '../../shared/types.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const significance = z.enum(SIGNIFICANCES);
const tone = z.enum(TONES);

/**
 * A link the model asks for between a node it writes and another node: an existing one by id, or one
 * written in the same result by "@key".
 */
const linkRef = z.object({
  node: z.string().trim().min(1).max(41),
  strength: z.enum(STRENGTHS),
  note: z.string().trim().max(400).default(''),
});
const links = {
  /** This node affects those existing nodes. */
  influences: z.array(linkRef).max(6).optional(),
  /** Those existing nodes affect this node. */
  influencedBy: z.array(linkRef).max(6).optional(),
};

const nodeContent = {
  /** Optional handle so other nodes in the same result can link to this one as "@key". */
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,40}$/i, 'letters, digits, - or _ only')
    .optional(),
  title: text(140),
  period: text(80),
  summary: text(800),
  narrative: text(8000),
  keyChanges: z.array(text(300)).min(1).max(10),
  significance,
  tone,
};

/** The first node of a new parallel thread (nested in a child, or top-level from the node being continued). */
export const threadStart = z.object({ thread: text(80), ...nodeContent, ...links });

/**
 * "This node's immediate consequences in another stream deserve their own event": the server queues an
 * INFLUENCE job (this node -> a new event after `target`), handled by another writer.
 */
const followUp = z.object({
  /** The latest event of another stream (marked "latest in stream" in the brief or search results). */
  target: z.string().trim().min(1).max(41),
  strength: z.enum(STRENGTHS),
  /** What the follow-up writer should show: the consequence to explore. */
  guidance: z.string().trim().min(1).max(600),
});

/** At most this many follow-ups per result. */
export const MAX_FOLLOW_UPS = 2;

/** Renames the stream from this node on, when its focus has clearly moved on from its current name. */
const streamName = z.string().trim().min(1).max(80).optional();

export const generatedNode = z.object({
  ...nodeContent,
  streamName,
  likelihood: z.number().gt(0).lte(1).optional(),
  ...links,
  spawnThreads: z.array(threadStart).max(2).optional(),
  followUps: z.array(followUp).max(MAX_FOLLOW_UPS).optional(),
});

export const continueResult = z
  .object({
    /** Alternatives: only one of them happens. */
    children: z.array(generatedNode).max(4).default([]),
    branchReason: z.string().trim().max(600).optional(),
    /** Parallel threads starting from the node being continued: all of them happen, alongside each other. */
    threads: z.array(threadStart).max(4).default([]),
    /** INFLUENCE only: one sentence on the effect, shown on the influence link. */
    influenceNote: z.string().trim().max(400).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.children.length && !val.threads.length) {
      ctx.addIssue({ code: 'custom', path: ['children'], message: 'give at least one child or one top-level thread' });
    }
    const keys = [...val.children, ...val.children.flatMap((c) => c.spawnThreads ?? []), ...val.threads]
      .map((n) => n.key)
      .filter(Boolean);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['key'], message: 'keys must be unique' });
    const followUps = val.children.reduce((n, c) => n + (c.followUps?.length ?? 0), 0);
    if (followUps > MAX_FOLLOW_UPS) {
      ctx.addIssue({ code: 'custom', path: ['children'], message: `at most ${MAX_FOLLOW_UPS} followUps in one result, across all children` });
    }
    if (val.children.length < 2) return;
    if (!val.branchReason) {
      ctx.addIssue({ code: 'custom', path: ['branchReason'], message: 'required when returning 2-4 children' });
    }
    val.children.forEach((c, i) => {
      if (c.likelihood === undefined) {
        ctx.addIssue({ code: 'custom', path: ['children', i, 'likelihood'], message: 'required when branching' });
      }
    });
  });

export const regenerateResult = z.object({ node: z.object({ ...nodeContent, streamName, ...links }) });

export type LinkRef = z.infer<typeof linkRef>;

export const linkInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  strength: z.enum(STRENGTHS),
  note: z.string().trim().max(400).default(''),
});

export const deviationInput = z.object({
  title: text(140),
  period: z.string().trim().max(80).default(''),
  summary: text(2000),
  narrative: z.string().trim().max(8000).default(''),
  significance: significance.default('pivotal'),
  tone: tone.default('neutral'),
  /** Set to start a parallel thread (happens alongside) instead of an alternative. */
  threadName: z.string().trim().max(80).optional(),
});

export const nodeEdit = z.object({
  title: text(140).optional(),
  period: z.string().trim().max(80).optional(),
  summary: z.string().trim().max(2000).optional(),
  narrative: z.string().trim().max(8000).optional(),
  keyChanges: z.array(z.string().trim().min(1).max(300)).max(15).optional(),
  significance: significance.optional(),
  tone: tone.optional(),
  /** Renames the stream from this node on; '' removes the rename. */
  streamName: z.string().trim().max(80).optional(),
});

export const generateOptions = z.object({
  timeSpan: z.string().trim().max(80).optional(),
  guidance: z.string().trim().max(1000).optional(),
});

export const influenceInput = generateOptions.extend({
  /** Nodes in other streams; the agent writes a new event after each one. */
  targets: z.array(z.string().min(1)).min(1).max(4),
  strength: z.enum(STRENGTHS).default('moderate'),
});

/** PUT /api/engine: switch engine and/or change built-in settings. apiKey '' removes a stored key. */
export const enginePatch = z.object({
  engine: z.enum(['external', 'builtin']).optional(),
  builtin: z
    .object({
      provider: z.enum(['anthropic', 'openai-compatible']).optional(),
      model: z.string().trim().max(200).optional(),
      baseUrl: z.string().trim().max(500).optional(),
      apiKey: z.string().trim().max(500).optional(),
      apiKeyEnv: z.string().trim().max(100).optional(),
      concurrency: z.number().int().min(1).max(8).optional(),
      maxOutputTokens: z.number().int().min(1000).max(64000).optional(),
      maxToolCalls: z.number().int().min(0).max(10).optional(),
      maxRepairs: z.number().int().min(0).max(5).optional(),
      timeoutMs: z.number().int().min(10_000).max(900_000).optional(),
    })
    .optional(),
});

export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}
