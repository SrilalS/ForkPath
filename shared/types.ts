// Types shared by the server and the web UI.

/**
 * Version of the on-disk / exported timeline format. Bump it whenever the shape of Timeline or TLNode
 * changes, and add a step to server/src/migrate.ts that upgrades the previous version.
 *   1: original format (no schemaVersion field)
 *   2: adds schemaVersion, node significance and tone
 *   3: adds node mergeParents (convergence of separate branches)
 *   4: adds parallel threads (node threadName) and timeline influence links
 */
export const SCHEMA_VERSION = 4;

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
  error?: string;
  createdAt: string;
  updatedAt: string;
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

export type JobType = 'continue' | 'regenerate' | 'merge';
export type JobStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  type: JobType;
  timelineId: string;
  /** continue: the parent node. regenerate: the node being rewritten. */
  targetNodeId: string;
  /** continue: the placeholder child created while waiting. */
  placeholderId?: string;
  /** merge: the other node(s) whose branch converges with targetNodeId. */
  mergeWith?: string[];
  timeSpan?: string;
  guidance?: string;
  status: JobStatus;
  createdAt: string;
  claimedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface WorkerStatus {
  online: boolean;
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
