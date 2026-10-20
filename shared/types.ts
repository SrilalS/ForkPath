// Types shared by the server and the web UI.

/**
 * Version of the on-disk / exported timeline format. Bump it whenever the shape of Timeline or TLNode
 * changes, and add a step to server/src/migrate.ts that upgrades the previous version.
 *   1: original format (no schemaVersion field)
 *   2: adds schemaVersion, node significance and tone
 *   3: adds node mergeParents (convergence of separate branches)
 *   4: adds parallel threads (node threadName) and timeline influence links
 *   5: adds node streamName (renames a stream from that node onward)
 *   6: adds node generation (which engine and model wrote it, tokens, cost)
 */
export const SCHEMA_VERSION = 6;

export type NodeKind = 'deviation' | 'event';
export type NodeSource = 'user' | 'llm' | 'llm-edited';
export type NodeStatus = 'ready' | 'generating' | 'error';

/** How much this development changes the course of history. Drives emphasis and the mood theme. */
export const SIGNIFICANCES = ['minor', 'notable', 'major', 'pivotal'] as const;
export type Significance = (typeof SIGNIFICANCES)[number];

/** The dominant character of a development. Major and pivotal nodes recolor the UI with it. */
export const TONES = [
  'neutral',
  'conflict',
  'catastrophe',
  'upheaval',
  'decline',
  'prosperity',
  'discovery',
  'diplomacy',
] as const;
export type Tone = (typeof TONES)[number];

export interface TLNode {
  id: string;
  /** Primary parent: the branch this node is drawn and read as continuing. */
  parentId: string | null;
  /**
   * Extra parents for a convergence node: other branches whose events merge into this one.
   * Never an ancestor or descendant of parentId, so the graph stays acyclic.
   */
  mergeParents?: string[];
  /**
   * Set when this node starts a parallel thread: a separate stream of events in the SAME world as its
   * parent, not an alternative to its siblings. Its descendants belong to the thread until the next one.
   */
  threadName?: string;
  /**
   * Renames the stream from this node onward, when its focus has moved on (a "Vietnam War" thread that is
   * now about Iran). Only a label: unlike threadName it starts nothing new and keeps the stream's color.
   */
  streamName?: string;
  kind: NodeKind;
  source: NodeSource;
  status: NodeStatus;
  /** Set on descendants when an ancestor is edited, until regenerated or kept. */
  stale: boolean;
  title: string;
  /** Free-form period label, e.g. "1863", "1863-1870", "Spring 1940". */
  period: string;
  summary: string;
  narrative: string;
  keyChanges: string[];
  significance: Significance;
  tone: Tone;
  /** 0..1, set when the LLM produced this node as one of several possible outcomes. */
  likelihood?: number;
  /** Why the LLM split here (shared by all siblings from one branching result). */
  branchReason?: string;
  /** Job currently producing content for this node (status === 'generating'). */
  jobId?: string;
  /** How the current content was generated (absent on user-written nodes and older files). */
  generation?: Generation;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How the writer leans when outcomes are close, chosen per request. 'realist' (the default) puts no thumb
 * on the scale: incentives, capabilities and historical base rates decide.
 */
export const TEMPERAMENTS = ['realist', 'grim', 'hopeful'] as const;
export type Temperament = (typeof TEMPERAMENTS)[number];

/**
 * Narrative format, chosen per request. 'beats' (the default): dated bullet points that keep every fact an
 * essay would hold, plus a closing "Why:" line. 'story': flowing prose paragraphs.
 */
export const DETAILS = ['beats', 'story'] as const;
export type Detail = (typeof DETAILS)[number];

/** Which engine and model wrote a node. Token and cost fields are only known for the built-in engine. */
export interface Generation {
  engine: 'external' | 'builtin';
  /** e.g. "claude-sonnet-4-6 via Anthropic", or "Claude Code worker". */
  model: string;
  jobType: JobType;
  at: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Whole job's cost in USD, when prices are configured. */
  costUsd?: number;
  /** Invalid results the model had to fix. */
  repairs?: number;
  /** Nodes written by the same job; tokens and cost are for the whole job, shared by all of them. */
  nodesInJob?: number;
  /** Set when the request asked for a lean other than realist. */
  temperament?: Temperament;
  /** Set when the request asked for prose instead of beats. */
  detail?: Detail;
}

export const STRENGTHS = ['mild', 'moderate', 'strong'] as const;
export type Strength = (typeof STRENGTHS)[number];

/** "Event `from` affects event `to`", across threads. Not a parent link: it only adds context. */
export interface InfluenceLink {
  id: string;
  from: string;
  to: string;
  strength: Strength;
  note: string;
  source: 'llm' | 'user';
  createdAt: string;
}

export interface Timeline {
  schemaVersion: number;
  id: string;
  title: string;
  rootId: string;
  nodes: Record<string, TLNode>;
  links: InfluenceLink[];
  createdAt: string;
  updatedAt: string;
}

/** A file produced by Export: a whole timeline, or one branch of it (root to a node, plus everything after it). */
export interface ExportFile {
  format: 'althistory';
  schemaVersion: number;
  exportedAt: string;
  /** 'timeline' = every node; 'branch' = the path to branchNodeId plus its descendants. */
  scope: 'timeline' | 'branch';
  branchNodeId?: string;
  timeline: Timeline;
}

export interface TimelineSummary {
  id: string;
  title: string;
  nodeCount: number;
  updatedAt: string;
}

export type JobType = 'continue' | 'regenerate' | 'merge' | 'influence';
export type JobStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  type: JobType;
  timelineId: string;
  /** continue, merge, influence: the parent node. regenerate: the node being rewritten. */
  targetNodeId: string;
  /** continue: the placeholder child created while waiting. */
  placeholderId?: string;
  /** merge: the other node(s) whose branch converges with targetNodeId. */
  mergeWith?: string[];
  /** influence: the event (in another stream) whose effect the new node after targetNodeId shows. */
  influenceFrom?: string;
  /** Set on INFLUENCE jobs a writer requested as a follow-up (1); such jobs cannot request more. */
  followUpDepth?: number;
  timeSpan?: string;
  guidance?: string;
  /** Lean for close calls; absent means realist. */
  temperament?: Temperament;
  /** Narrative format; absent means beats. */
  detail?: Detail;
  status: JobStatus;
  createdAt: string;
  claimedAt?: string;
  /** Which engine holds the claim: the external worker or the built-in runner. */
  claimedBy?: 'external' | 'builtin';
  /**
   * When the claimant actually received the brief. A claim made with --id-only only counts once the writer
   * fetches the brief; until then it may have gone to a poll whose session is gone.
   */
  deliveredAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface WorkerStatus {
  /** The engine that generates jobs: the external worker session, or the server's built-in runner. */
  engine: 'external' | 'builtin';
  online: boolean;
  /** Built-in only: provider and model, e.g. "claude-sonnet-4-6 via Anthropic". */
  label?: string;
  /** Built-in only: why it cannot run (missing key or model). */
  problem?: string;
  lastSeenAt: string | null;
  pending: number;
  claimed: number;
}

export type ServerEvent =
  | { type: 'timeline'; timeline: Timeline }
  | { type: 'timeline-deleted'; id: string }
  | { type: 'timelines'; timelines: TimelineSummary[] }
  | { type: 'worker'; status: WorkerStatus }
  | { type: 'ping' };
