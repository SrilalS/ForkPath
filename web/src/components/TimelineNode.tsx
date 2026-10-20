import { createContext, memo, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode } from '../layout.ts';
import { isMajor, SIGNIFICANCE_LABEL, TONE_STYLE } from '../mood.ts';

/**
 * What every card reads. Keep this value stable: any change re-renders every card on the canvas, so it
 * only changes when every card's look changes anyway (pick mode, the Most likely set).
 */
export interface CanvasActions {
  quickContinue: (nodeId: string) => void;
  /** Set while the user is picking a second node (to merge with, or to influence). */
  pick: { kind: 'merge' | 'link'; sourceId: string; targets: Set<string>; selected: Set<string> } | null;
  /** Set while "Most likely" is on: nodes outside the most likely history, drawn faded. */
  unlikely: Set<string> | null;
}
export const CanvasActionsContext = createContext<CanvasActions>({ quickContinue: () => {}, pick: null, unlikely: null });

/** Separate from CanvasActions: only generating cards show it, so a worker going on or offline re-renders just those. */
export const WorkerOnlineContext = createContext(false);

function WorkerHint() {
  const workerOnline = useContext(WorkerOnlineContext);
  return (
    <div className="tl-node__hint">
      <span className={`dot ${workerOnline ? 'dot--on' : 'dot--off'}`} />
      {workerOnline ? 'Worker is on it' : 'Waiting for worker to come online'}
    </div>
  );
}

function kindLabel(isRoot: boolean, node: { kind: string; mergeParents?: string[] }) {
  if (isRoot) return 'Point of divergence';
  if (node.mergeParents?.length) return 'Convergence';
  return node.kind === 'deviation' ? 'New deviation' : 'Event';
}

function TimelineNodeView({ data, selected }: NodeProps<FlowNode>) {
  const { node, isRoot, thread } = data;
  const { quickContinue, pick, unlikely } = useContext(CanvasActionsContext);
  const generating = node.status === 'generating';
  const errored = node.status === 'error';

  const major = isMajor(node) && node.status === 'ready';
  const tone = TONE_STYLE[node.tone];
  const cls = [
    'tl-node',
    `tl-node--${node.kind}`,
    isRoot && 'tl-node--root',
    major && 'is-major',
    major && node.significance === 'pivotal' && 'is-pivotal',
    selected && 'is-selected',
    generating && 'is-generating',
    errored && 'is-error',
    node.stale && 'is-stale',
    thread && 'in-thread',
    !pick && unlikely?.has(node.id) && 'is-unlikely',
    pick && `pick-${pick.kind}`,
    pick &&
      (pick.sourceId === node.id || pick.selected.has(node.id)
        ? 'is-pick-source'
        : pick.targets.has(node.id)
          ? 'is-pick-target'
          : 'is-pick-blocked'),
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      style={{ ...(major ? { '--tone': tone.color } : {}), ...(thread ? { '--thread': thread.color } : {}) } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="tl-handle" isConnectable={false} />

      <div className="tl-node__head">
        {thread?.isStart && !major ? (
          <span className="tl-chip tl-chip--thread" title="Starts a parallel thread: happens alongside, not instead">
            🧵 New thread
          </span>
        ) : major ? (
          <span className="tl-chip tl-chip--tone" title={tone.label}>
            {tone.icon} {SIGNIFICANCE_LABEL[node.significance]}
          </span>
        ) : (
          <span className={`tl-chip ${node.mergeParents?.length ? 'tl-chip--merge' : ''}`}>{kindLabel(isRoot, node)}</span>
        )}
        {node.period && !generating && (
          <span className="tl-node__period" title={node.period}>
            {node.period}
          </span>
        )}
      </div>

      {generating ? (
        <div className="tl-node__pending">
          <div className="tl-node__title">{node.title === 'Generating...' ? 'Writing what happens next' : node.title}</div>
          <div className="shimmer" />
          <div className="shimmer shimmer--short" />
          <WorkerHint />
        </div>
      ) : errored ? (
        <div className="tl-node__body">
          <div className="tl-node__title">Generation failed</div>
          <p className="tl-node__summary">{node.error}</p>
        </div>
      ) : (
        <div className="tl-node__body">
          <div className="tl-node__title">{node.title}</div>
          <p className="tl-node__summary">{node.summary}</p>
        </div>
      )}

      <div className="tl-node__foot">
        {node.likelihood !== undefined && (
          <span className="tl-likelihood" title={node.branchReason}>
            <span className="tl-likelihood__bar">
              <span style={{ width: `${Math.round(node.likelihood * 100)}%` }} />
            </span>
            {Math.round(node.likelihood * 100)}%
          </span>
        )}
        {thread && (
          <span className="tl-thread" title={`Thread: ${thread.name}`}>
            {thread.name}
          </span>
        )}
        {node.stale && <span className="tl-badge tl-badge--stale">Stale</span>}
        {node.source === 'llm-edited' && <span className="tl-badge">Edited</span>}
        {node.error && !errored && <span className="tl-badge tl-badge--error">Last regen failed</span>}
      </div>

      <Handle type="source" position={Position.Right} className="tl-handle" isConnectable={false} />
      {node.status === 'ready' && !pick && (
        <button
          className="tl-node__plus nodrag"
          title="Continue from here (choose span and guidance first)"
          onClick={(e) => {
            e.stopPropagation();
            quickContinue(node.id);
          }}
        >
          +
        </button>
      )}
    </div>
  );
}

export const TimelineNode = memo(TimelineNodeView);
