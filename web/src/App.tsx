import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  ViewportPortal,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react';
import type { Timeline, TimelineSummary, WorkerStatus } from '../../shared/types.ts';
import { api } from './api.ts';
import { useLive } from './live.ts';
import { NODE_H, NODE_W, toFlow, type FlowNode, type LayoutMode, type TimeAxis } from './layout.ts';
import { CanvasActionsContext, TimelineNode, type CanvasActions } from './components/TimelineNode.tsx';
import { InfluenceEdge } from './components/InfluenceEdge.tsx';
import { NodePanel, PANEL_DEFAULT, PANEL_MIN, panelMax } from './components/NodePanel.tsx';
import { DeviationDialog, InfluenceDialog, MergeDialog } from './components/forms.tsx';
import { AboutPage, GuidePage } from './components/Pages.tsx';
import { isMajor, moodFor, SIGNIFICANCE_LABEL, TONE_STYLE, type Mood } from './mood.ts';
import { childrenOf, influenceBlocker, influenceTargets, mergeTargets, streamLabel } from './graph.ts';

const nodeTypes: NodeTypes = { timeline: TimelineNode };
const edgeTypes: EdgeTypes = { influence: InfluenceEdge };
const PANEL_WIDTH_KEY = 'althistory.panelWidth';
/** Matches the server: one node plus up to this many others per merge. */
const MAX_MERGE_WITH = 4;
/** Matches the server: one event can influence up to this many streams at once. */
const MAX_INFLUENCE_TARGETS = 4;
const layoutKey = (timelineId: string) => `althistory.layout.${timelineId}`;

/** Layout choice per timeline, remembered in this browser. Defaults to the compact tree. */
function useLayoutMode(timelineId: string | null): [LayoutMode, (m: LayoutMode) => void] {
  const read = (id: string | null): LayoutMode => {
    try {
      return id && localStorage.getItem(layoutKey(id)) === 'time' ? 'time' : 'structure';
    } catch {
      return 'structure';
    }
  };
  const [state, setState] = useState(() => ({ id: timelineId, mode: read(timelineId) }));
  const mode = state.id === timelineId ? state.mode : read(timelineId);
  const set = useCallback(
    (m: LayoutMode) => {
      setState({ id: timelineId, mode: m });
      try {
        if (timelineId) localStorage.setItem(layoutKey(timelineId), m);
      } catch {
        // storage unavailable: the choice just won't persist
      }
    },
    [timelineId],
  );
  return [mode, set];
}

/** Static pages, routed as #/guide and #/about (timeline ids never collide: they are hex). */
type Page = 'guide' | 'about';
const PAGES: Page[] = ['guide', 'about'];

function readHash(): { tl: string | null; node: string | null; page: Page | null } {
  const [tl, node] = window.location.hash.replace(/^#\/?/, '').split('/');
  if (PAGES.includes(tl as Page)) return { tl: null, node: null, page: tl as Page };
  return { tl: tl || null, node: node || null, page: null };
}

const SIDEBAR_KEY = 'althistory.sidebarCollapsed';

/** Sidebar collapsed to an icon rail, remembered in this browser. */
function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1');
      } catch {
        // storage unavailable: the choice just won't persist
      }
      return !c;
    });
  }, []);
  return [collapsed, toggle];
}

function relTime(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function App() {
  const [route, setRoute] = useState(readHash);
  const { connected, timelines, worker, timeline, loaded } = useLive(route.tl);
  const [dialog, setDialog] = useState<
    | { kind: 'new' }
    | { kind: 'branch'; nodeId: string }
    | { kind: 'merge'; a: string; others: string[] }
    | { kind: 'influence'; from: string; targets: string[] }
    | null
  >(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const [layoutMode, setLayoutMode] = useLayoutMode(route.tl);
  /** Node waiting for picks on the canvas: nodes to converge with, or nodes whose streams it influences. */
  const [pickSource, setPickSource] = useState<{ kind: 'merge' | 'link'; id: string; selected?: string[] } | null>(null);
  /** Set by a node's + button: open the side panel on that node with the Continue form showing. */
  const [continueRequest, setContinueRequest] = useState<{ id: string; at: number } | null>(null);
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
      return saved >= PANEL_MIN ? Math.min(saved, panelMax()) : PANEL_DEFAULT;
    } catch {
      return PANEL_DEFAULT;
    }
  });
  const resizePanel = useCallback((w: number) => {
    setPanelWidth(w);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(w)));
    } catch {
      // storage unavailable: width just won't persist
    }
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((tl: string | null, node: string | null = null) => {
    const hash = tl ? `#/${tl}${node ? `/${node}` : ''}` : '#/';
    if (window.location.hash !== hash) window.history.pushState(null, '', hash);
    setRoute({ tl, node, page: null });
  }, []);
  const openPage = useCallback((page: Page) => {
    const hash = `#/${page}`;
    if (window.location.hash !== hash) window.history.pushState(null, '', hash);
    setRoute({ tl: null, node: null, page });
  }, []);
  const [sidebarCollapsed, toggleSidebar] = useSidebarCollapsed();

  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const selectNode = useCallback((id: string | null) => navigate(route.tl, id), [navigate, route.tl]);

  // Timeline was deleted (here or elsewhere) or the link is bad.
  useEffect(() => {
    if (loaded && route.tl && !timeline) navigate(null);
  }, [loaded, route.tl, timeline, navigate]);

  const selected = timeline && route.node ? timeline.nodes[route.node] : undefined;
  const workerOnline = worker?.online ?? false;

  const pick = useMemo<CanvasActions['pick']>(() => {
    if (!timeline || !pickSource || !timeline.nodes[pickSource.id]) return null;
    // Nodes deleted while picking drop out of the selection.
    const chosen = (pickSource.selected ?? []).filter((id) => timeline.nodes[id]);
    const targets =
      pickSource.kind === 'merge' ? mergeTargets(timeline, pickSource.id, chosen) : influenceTargets(timeline, pickSource.id);
    return { kind: pickSource.kind, sourceId: pickSource.id, targets, selected: new Set(chosen) };
  }, [timeline, pickSource]);
  // Leaving the timeline (or the source vanishing) ends pick mode.
  useEffect(() => {
    if (pickSource && !pick) setPickSource(null);
  }, [pickSource, pick]);
  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPickSource(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pick]);

  const pickTarget = useCallback(
    (id: string) => {
      if (!pick || !timeline) return;
      if (id === pick.sourceId) return;
      if (!pick.targets.has(id)) {
        if (pick.kind === 'merge') {
          toast('Pick a node on a separate branch from all the selected ones. Nodes before or after them are on the same path.');
        } else {
          toast(`Cannot influence: ${influenceBlocker(timeline, pick.sourceId, id) ?? 'not available'}.`);
        }
        return;
      }
      // Clicks toggle nodes in and out of the selection; the banner's button confirms.
      setPickSource((cur) => {
        if (!cur) return cur;
        const sel = cur.selected ?? [];
        if (sel.includes(id)) return { ...cur, selected: sel.filter((x) => x !== id) };
        const max = cur.kind === 'merge' ? MAX_MERGE_WITH : MAX_INFLUENCE_TARGETS;
        if (sel.length >= max) {
          toast(cur.kind === 'merge' ? `Merge at most ${max + 1} storylines at once.` : `Influence at most ${max} streams at once.`);
          return cur;
        }
        return { ...cur, selected: [...sel, id] };
      });
    },
    [pick, timeline, toast],
  );
  const mood = moodFor(timeline, selected);
  const moodVars = { '--mood': mood.color, '--mood-strength': mood.strength } as React.CSSProperties;

  async function importFromFile(file: File) {
    try {
      const tl = await api.importFile(JSON.parse(await file.text()));
      navigate(tl.id);
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : (err as Error).message);
    }
  }

  return (
    <div className={`app ${mood.strength > 0 ? 'has-mood' : ''} ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`} style={moodVars}>
      <Sidebar
        timelines={timelines}
        activeId={route.tl}
        activePage={route.page}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        onPage={openPage}
        worker={worker}
        connected={connected}
        onOpen={(id) => navigate(id)}
        onNew={() => (route.tl ? setDialog({ kind: 'new' }) : navigate(null))}
        onImport={importFromFile}
        onDelete={async (t) => {
          if (!confirm(`Delete the timeline "${t.title}" and all ${t.nodeCount} nodes?`)) return;
          try {
            await api.deleteTimeline(t.id);
            if (route.tl === t.id) navigate(null);
          } catch (err) {
            toast((err as Error).message);
          }
        }}
      />

      <main className="main">
        {route.page === 'guide' ? (
          <GuidePage />
        ) : route.page === 'about' ? (
          <AboutPage />
        ) : route.tl && timeline ? (
          <>
            <Canvas
              timeline={timeline}
              selectedId={route.node}
              workerOnline={workerOnline}
              panelWidth={selected ? panelWidth : 0}
              layoutMode={layoutMode}
              pick={pick}
              onPick={pickTarget}
              onRequestContinue={(id) => {
                selectNode(id);
                setContinueRequest({ id, at: Date.now() });
              }}
              onSelect={selectNode}
              onError={toast}
            />
            <TopBar
              timeline={timeline}
              mood={mood}
              layoutMode={layoutMode}
              onLayoutMode={setLayoutMode}
              onSelect={selectNode}
              onError={toast}
            />
            {pick && (
              <div className={`merge-banner merge-banner--${pick.kind}`}>
                {pick.kind === 'merge' ? (
                  <>
                    <span>
                      ⤚⤙ Pick the storylines to merge with <strong>{timeline.nodes[pick.sourceId].title}</strong>
                    </span>
                    <span className="muted small">
                      {pick.selected.size ? `${pick.selected.size} selected · click again to remove` : 'Click one or more highlighted nodes'}
                    </span>
                    <button
                      className="btn btn--small btn--primary"
                      disabled={!pick.selected.size}
                      onClick={() => setDialog({ kind: 'merge', a: pick.sourceId, others: [...pick.selected] })}
                    >
                      Merge {pick.selected.size + 1}
                    </button>
                  </>
                ) : (
                  <>
                    <span>
                      ⇢ Pick where <strong>{timeline.nodes[pick.sourceId].title}</strong> affects other streams
                    </span>
                    <span className="muted small">
                      {pick.selected.size
                        ? `${pick.selected.size} selected · click again to remove`
                        : 'Click one or more highlighted nodes; a new event is written after each'}
                    </span>
                    <button
                      className="btn btn--small btn--primary"
                      disabled={!pick.selected.size}
                      onClick={() => setDialog({ kind: 'influence', from: pick.sourceId, targets: [...pick.selected] })}
                    >
                      Influence {pick.selected.size || ''}
                    </button>
                  </>
                )}
                <button className="btn btn--small" onClick={() => setPickSource(null)}>
                  Cancel
                </button>
              </div>
            )}
            {selected && (
              <NodePanel
                key={timeline.id}
                timeline={timeline}
                node={selected}
                workerOnline={workerOnline}
                width={panelWidth}
                picking={!!pick}
                onResize={resizePanel}
                onSelect={selectNode}
                onBranch={(nodeId) => setDialog({ kind: 'branch', nodeId })}
                onStartMerge={(id) => setPickSource({ kind: 'merge', id })}
                onStartLink={(id) => setPickSource({ kind: 'link', id })}
                continueRequest={continueRequest}
                onError={toast}
              />
            )}
          </>
        ) : route.tl && !loaded ? (
          <div className="loading">Loading timeline...</div>
        ) : (
          <Landing
            timelines={timelines}
            workerOnline={workerOnline}
            onOpen={(id) => navigate(id)}
            onAdvanced={() => setDialog({ kind: 'new' })}
            onCreated={(tl) => navigate(tl.id, Object.values(tl.nodes).find((n) => n.parentId)?.id ?? tl.rootId)}
            onError={toast}
          />
        )}
      </main>

      {dialog?.kind === 'new' && (
        <DeviationDialog
          title="New timeline"
          subtitle="Describe the moment history goes differently."
          submitLabel="Create timeline"
          onClose={() => setDialog(null)}
          onSubmit={async (d, auto, opts) => {
            const tl = await api.createTimeline(d, auto, opts);
            navigate(tl.id, Object.values(tl.nodes).find((n) => n.parentId)?.id ?? tl.rootId);
          }}
        />
      )}
      {dialog?.kind === 'branch' && timeline && (
        <DeviationDialog
          title="Branch from here"
          subtitle={`Something new starts after "${timeline.nodes[dialog.nodeId]?.title}". The existing path stays untouched.`}
          submitLabel="Create branch"
          allowThread
          onClose={() => setDialog(null)}
          onSubmit={async (d, auto, opts) => {
            const dev = await api.branch(timeline.id, dialog.nodeId, d, auto, opts);
            selectNode(dev.id);
          }}
        />
      )}

      {dialog?.kind === 'merge' && timeline && [dialog.a, ...dialog.others].every((id) => timeline.nodes[id]) && (
        <MergeDialog
          nodes={[dialog.a, ...dialog.others].map((id) => timeline.nodes[id])}
          onClose={() => setDialog(null)}
          onSubmit={async (opts) => {
            const node = await api.merge(timeline.id, dialog.a, dialog.others, opts);
            setPickSource(null);
            selectNode(node.id);
          }}
        />
      )}

      {dialog?.kind === 'influence' && timeline && [dialog.from, ...dialog.targets].every((id) => timeline.nodes[id]) && (
        <InfluenceDialog
          from={timeline.nodes[dialog.from]}
          targets={dialog.targets.map((id) => ({
            ...timeline.nodes[id],
            stream: streamLabel(timeline, id),
            existing: childrenOf(timeline, id).filter((c) => c.parentId === id && !c.threadName).length,
          }))}
          onClose={() => setDialog(null)}
          onSubmit={async (strength, opts) => {
            const created = await api.influence(timeline.id, dialog.from, dialog.targets, strength, opts);
            setPickSource(null);
            if (created[0]) selectNode(created[0].id);
          }}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- canvas ----------------------------------------------------------------

function Canvas({
  timeline,
  selectedId,
  workerOnline,
  panelWidth,
  layoutMode,
  pick,
  onPick,
  onRequestContinue,
  onSelect,
  onError,
}: {
  timeline: Timeline;
  selectedId: string | null;
  workerOnline: boolean;
  /** Width of the side panel covering the right of the canvas (0 when closed). */
  panelWidth: number;
  layoutMode: LayoutMode;
  pick: CanvasActions['pick'];
  onPick: (id: string) => void;
  onRequestContinue: (id: string) => void;
  onSelect: (id: string | null) => void;
  onError: (msg: string) => void;
}) {
  const flow = useReactFlow();
  const { nodes, edges, axis } = useMemo(() => toFlow(timeline, layoutMode), [timeline, layoutMode]);
  const withSelection = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedId })), [nodes, selectedId]);
  const fittedFor = useRef<string | null>(null);
  const prevSelected = useRef<string | null>(null);

  // Center a node in the part of the canvas the side panel does not cover.
  const centerOn = useCallback(
    (n: FlowNode, zoom: number, duration: number) => {
      const el = document.querySelector('.react-flow');
      const panelW = el && el.clientWidth - panelWidth > 320 ? panelWidth + 20 : 0;
      flow.setCenter(n.position.x + NODE_W / 2 + panelW / 2 / zoom, n.position.y + NODE_H / 2, { zoom, duration });
    },
    [flow, panelWidth],
  );

  // Fit once per timeline after its first layout.
  useEffect(() => {
    if (fittedFor.current === timeline.id) return;
    fittedFor.current = timeline.id;
    prevSelected.current = selectedId;
    requestAnimationFrame(() => {
      const target = selectedId && nodes.find((n) => n.id === selectedId);
      if (target) centerOn(target, 0.9, 0);
      else flow.fitView({ padding: 0.25, maxZoom: 1, duration: 0 });
    });
  }, [timeline.id, nodes, selectedId, flow, centerOn]);

  // Bring a newly selected node into view if it is off screen or under the panel.
  useEffect(() => {
    if (!selectedId || selectedId === prevSelected.current) return;
    prevSelected.current = selectedId;
    const n = nodes.find((x) => x.id === selectedId);
    const el = document.querySelector('.react-flow');
    if (!n || !el) return;
    const rect = el.getBoundingClientRect();
    const panelW = rect.width - panelWidth > 320 ? panelWidth + 20 : 0;
    const zoom = flow.getZoom();
    const left = flow.flowToScreenPosition({ x: n.position.x, y: n.position.y });
    const right = flow.flowToScreenPosition({ x: n.position.x + NODE_W, y: n.position.y + NODE_H });
    const visible = left.x > rect.left + 10 && right.x < rect.right - panelW && left.y > rect.top + 50 && right.y < rect.bottom - 10;
    if (!visible) centerOn(n, zoom, 500);
  }, [selectedId, nodes, flow, centerOn, panelWidth]);

  const actions = useMemo<CanvasActions>(
    () => ({
      workerOnline,
      pick,
      // Opens the Continue form for that node; nothing is generated until the user submits it.
      quickContinue: onRequestContinue,
    }),
    [workerOnline, pick, onRequestContinue],
  );

  return (
    <CanvasActionsContext.Provider value={actions}>
      <ReactFlow<FlowNode>
        nodes={withSelection}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => (pick ? onPick(n.id) : onSelect(n.id))}
        onPaneClick={() => !pick && onSelect(null)}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.15}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--grid)" />
        {axis && <TimeAxisOverlay axis={axis} />}
        <MiniMap
          pannable
          zoomable
          className="minimap"
          nodeColor={(n) => {
            const d = (n as FlowNode).data;
            if (d.node.status === 'generating') return '#5b5f7a';
            if (d.node.stale) return '#d68a3a';
            if (d.node.kind === 'deviation') return '#f5b041';
            return isMajor(d.node) ? TONE_STYLE[d.node.tone].color : '#7d74c9';
          }}
          maskColor="rgba(20, 22, 34, 0.65)"
        />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </CanvasActionsContext.Provider>
  );
}

/** Year labels and faint column bands, drawn in flow coordinates behind the nodes. */
function TimeAxisOverlay({ axis }: { axis: TimeAxis }) {
  const height = axis.bottom - axis.top + 90;
  return (
    <ViewportPortal>
      <div className="time-axis">
        {axis.columns.map((c, i) => (
          <div
            key={i}
            className={`time-col ${c.repeat ? 'is-repeat' : ''} ${i % 2 ? 'is-odd' : ''}`}
            style={{ transform: `translate(${c.x - 20}px, ${axis.top - 70}px)`, width: NODE_W + 40, height }}
          >
            <span className="time-col__label">{c.repeat ? `${c.label} ·` : c.label}</span>
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}

// ---- chrome ----------------------------------------------------------------

function TopBar({
  timeline,
  mood,
  layoutMode,
  onLayoutMode,
  onSelect,
  onError,
}: {
  timeline: Timeline;
  mood: Mood;
  layoutMode: LayoutMode;
  onLayoutMode: (m: LayoutMode) => void;
  onSelect: (id: string) => void;
  onError: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(timeline.title);
  const flow = useReactFlow();
  useEffect(() => setTitle(timeline.title), [timeline.title]);

  const nodes = Object.values(timeline.nodes);
  const branches = nodes.filter((n) => !nodes.some((c) => c.parentId === n.id)).length;
  const stale = nodes.filter((n) => n.stale).length;
  const generating = nodes.filter((n) => n.status === 'generating').length;

  async function save() {
    setEditing(false);
    if (title.trim() && title.trim() !== timeline.title) {
      try {
        await api.renameTimeline(timeline.id, title.trim());
      } catch (err) {
        onError((err as Error).message);
      }
    } else setTitle(timeline.title);
  }

  return (
    <div className="topbar">
      {editing ? (
        <input
          className="topbar__title-input"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              setTitle(timeline.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <h1 className="topbar__title" onClick={() => setEditing(true)} title="Click to rename">
          {timeline.title}
        </h1>
      )}
      <div className="topbar__stats">
        <span>{nodes.length} nodes</span>
        <span>{branches} {branches === 1 ? 'path' : 'paths'}</span>
        {stale > 0 && <span className="stat--warn">{stale} stale</span>}
        {generating > 0 && <span className="stat--busy">{generating} generating</span>}
        <button
          className={`btn btn--small ${layoutMode === 'time' ? 'btn--toggled' : 'btn--ghost'}`}
          aria-pressed={layoutMode === 'time'}
          onClick={() => {
            onLayoutMode(layoutMode === 'time' ? 'structure' : 'time');
            // Let the new layout render before fitting it.
            setTimeout(() => flow.fitView({ padding: 0.2, maxZoom: 1, duration: 500 }), 50);
          }}
          title={layoutMode === 'time' ? 'Back to the compact tree layout' : 'Line nodes up by date across all branches'}
        >
          {layoutMode === 'time' ? '◷ Aligned by time' : '◷ Align by time'}
        </button>
        <button className="btn btn--small btn--ghost" onClick={() => flow.fitView({ padding: 0.25, maxZoom: 1, duration: 400 })}>
          Fit view
        </button>
        <a className="btn btn--small btn--ghost" href={api.exportUrl(timeline.id)} download title="Download the whole timeline as a file">
          Export
        </a>
      </div>
      {mood.source && (
        <button
          key={mood.source.id}
          className={`mood-pill ${mood.foreshadow ? 'is-foreshadow' : ''}`}
          onClick={() => onSelect(mood.source!.id)}
          title={mood.source.title}
        >
          <span className="mood-pill__icon">{TONE_STYLE[mood.tone].icon}</span>
          {mood.foreshadow
            ? `${SIGNIFICANCE_LABEL[mood.source.significance]} ${TONE_STYLE[mood.tone].label.toLowerCase()} ahead`
            : `${SIGNIFICANCE_LABEL[mood.source.significance]} · ${TONE_STYLE[mood.tone].label}`}
        </button>
      )}
    </div>
  );
}

/** Small stroke icons for the sidebar rail. */
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  import: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v5h14v-5',
  guide: 'M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5c-.8 0-1.5-.7-1.5-1.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z',
  about: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5v.5',
  collapse: 'M15 6l-6 6 6 6',
  expand: 'M9 6l6 6-6 6',
} as const;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

function Sidebar({
  timelines,
  activeId,
  activePage,
  collapsed,
  onToggle,
  onPage,
  worker,
  connected,
  onOpen,
  onNew,
  onImport,
  onDelete,
}: {
  timelines: TimelineSummary[];
  activeId: string | null;
  activePage: Page | null;
  collapsed: boolean;
  onToggle: () => void;
  onPage: (p: Page) => void;
  worker: WorkerStatus | null;
  connected: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onImport: (file: File) => void;
  onDelete: (t: TimelineSummary) => void;
}) {
  const online = worker?.online ?? false;
  const fileInput = useRef<HTMLInputElement>(null);
  const queued = (worker?.pending ?? 0) + (worker?.claimed ?? 0);
  const workerTitle = !connected ? 'Backend offline' : online ? 'Worker online' : 'Worker offline';
  const nav = (
    <div className="sidebar__nav">
      {(
        [
          ['guide', 'Guide'],
          ['about', 'About'],
        ] as const
      ).map(([p, label]) => (
        <button key={p} className={`sidebar__link ${activePage === p ? 'is-active' : ''}`} onClick={() => onPage(p)} title={label}>
          <Icon name={p} />
          <span className="sidebar__text">{label}</span>
        </button>
      ))}
    </div>
  );
  return (
    <nav className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar__top">
        <div className="brand" onClick={() => (window.location.hash = '#/')} title="AltHistory home">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
            <path d="M9 16 C17 16 16 8 22 8 M9 16 C17 16 16 24 22 24" stroke="var(--accent-soft)" strokeWidth="2" fill="none" />
            <circle cx="8" cy="16" r="4" fill="var(--amber)" />
            <circle cx="24" cy="8" r="4" fill="var(--accent)" />
            <circle cx="24" cy="24" r="4" fill="var(--accent)" />
          </svg>
          <span className="sidebar__text">AltHistory</span>
        </div>
        <button
          className="icon-btn sidebar__toggle"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          <Icon name={collapsed ? 'expand' : 'collapse'} />
        </button>
      </div>

      {collapsed ? (
        <div className="sidebar__rail">
          <button className="btn btn--primary sidebar__icon-btn" onClick={onNew} title="New timeline" aria-label="New timeline">
            <Icon name="plus" />
          </button>
          <button className="btn sidebar__icon-btn" onClick={() => fileInput.current?.click()} title="Import a saved file" aria-label="Import">
            <Icon name="import" />
          </button>
          {timelines.slice(0, 8).map((t) => (
            <button
              key={t.id}
              className={`sidebar__initial ${t.id === activeId ? 'is-active' : ''}`}
              onClick={() => onOpen(t.id)}
              title={`${t.title} (${t.nodeCount} nodes)`}
            >
              {t.title.trim().charAt(0).toUpperCase() || '?'}
            </button>
          ))}
        </div>
      ) : (
        <div className="sidebar__actions">
          <button className="btn btn--primary" onClick={onNew}>
            + New timeline
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} title="Open an exported timeline or branch file">
            Import
          </button>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f);
          e.target.value = '';
        }}
      />

      {collapsed ? (
        <>
          <div className="sidebar__spacer" />
          {nav}
          <div className={`worker-dot ${online ? 'is-online' : ''}`} title={`${workerTitle}${queued ? ` · ${queued} queued` : ''}`}>
            <span className={`dot ${online ? 'dot--on dot--pulse' : 'dot--off'}`} />
            {queued > 0 && <span className="worker-dot__count">{queued}</span>}
          </div>
        </>
      ) : (
        <SidebarBody
          timelines={timelines}
          activeId={activeId}
          onOpen={onOpen}
          onDelete={onDelete}
          nav={nav}
          online={online}
          connected={connected}
          queued={queued}
          workerTitle={workerTitle}
        />
      )}
    </nav>
  );
}

function SidebarBody({
  timelines,
  activeId,
  onOpen,
  onDelete,
  nav,
  online,
  connected,
  queued,
  workerTitle,
}: {
  timelines: TimelineSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (t: TimelineSummary) => void;
  nav: React.ReactNode;
  online: boolean;
  connected: boolean;
  queued: number;
  workerTitle: string;
}) {
  return (
    <>
      <div className="sidebar__label">Timelines</div>
      <div className="sidebar__list">
        {timelines.length === 0 && <p className="muted small sidebar__empty">No timelines yet.</p>}
        {timelines.map((t) => (
          <div key={t.id} className={`tl-item ${t.id === activeId ? 'is-active' : ''}`} onClick={() => onOpen(t.id)}>
            <div className="tl-item__title">{t.title}</div>
            <div className="tl-item__meta">
              {t.nodeCount} nodes · {relTime(t.updatedAt)}
            </div>
            <button
              className="tl-item__delete icon-btn"
              title="Delete timeline"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(t);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {nav}

      <div className={`worker-card ${online ? 'is-online' : ''}`}>
        <div className="worker-card__row">
          <span className={`dot ${online ? 'dot--on' : 'dot--off'} ${online ? 'dot--pulse' : ''}`} />
          <strong>{workerTitle}</strong>
        </div>
        <div className="muted small">
          {!connected
            ? 'Start it with npm run dev.'
            : queued
              ? `${queued} job${queued > 1 ? 's' : ''} in queue`
              : online
                ? 'Ready for the next request.'
                : 'Start the Claude worker session to generate nodes.'}
        </div>
      </div>
    </>
  );
}

const EXAMPLES = [
  { summary: 'The Library of Alexandria is never destroyed and becomes a continuous center of learning.', period: '48 BC' },
  { summary: 'Archduke Franz Ferdinand’s driver takes the planned route and the assassination in Sarajevo fails.', period: 'June 1914' },
  { summary: 'The Ming treasure fleets keep sailing after Zheng He and reach the Americas.', period: '1433' },
  { summary: 'Xerox commercializes the Alto personal computer in 1975 instead of shelving it.', period: '1975' },
];

function Landing({
  timelines,
  workerOnline,
  onOpen,
  onAdvanced,
  onCreated,
  onError,
}: {
  timelines: TimelineSummary[];
  workerOnline: boolean;
  onOpen: (id: string) => void;
  onAdvanced: () => void;
  onCreated: (tl: Timeline) => void;
  onError: (m: string) => void;
}) {
  const [summary, setSummary] = useState('');
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!summary.trim() || busy) return;
    setBusy(true);
    try {
      const s = summary.trim();
      const tl = await api.createTimeline({ title: s.split(/[.!?]/)[0].slice(0, 80), period: period.trim(), summary: s }, true);
      onCreated(tl);
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="landing">
      <div className="landing__glow" />
      <form className="hero" onSubmit={create}>
        <h1>
          What if<span className="hero__q">...?</span>
        </h1>
        <p className="muted">Describe one change to history. Watch the consequences branch out.</p>
        <div className="hero__box">
          <textarea
            autoFocus
            rows={3}
            placeholder="The Roman Empire adopts the steam engine after Hero of Alexandria's aeolipile..."
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) create(e);
            }}
          />
          <div className="hero__bar">
            <input placeholder="When? (e.g. 60 AD)" value={period} onChange={(e) => setPeriod(e.target.value)} />
            <button type="button" className="btn btn--ghost btn--small" onClick={onAdvanced}>
              More options
            </button>
            <button className="btn btn--primary" disabled={!summary.trim() || busy}>
              {busy ? 'Diverging...' : 'Diverge'}
            </button>
          </div>
        </div>
        {!workerOnline && <p className="hero__note">The worker is offline. Your timeline will be saved and generated once it connects.</p>}
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex.summary}
              className="example"
              onClick={() => {
                setSummary(ex.summary);
                setPeriod(ex.period);
              }}
            >
              <span className="example__period">{ex.period}</span>
              {ex.summary}
            </button>
          ))}
        </div>
      </form>

      {timelines.length > 0 && (
        <div className="recent">
          <h3>Recent timelines</h3>
          <div className="recent__grid">
            {timelines.slice(0, 6).map((t) => (
              <button key={t.id} className="recent__card" onClick={() => onOpen(t.id)}>
                <strong>{t.title}</strong>
                <span className="muted small">
                  {t.nodeCount} nodes · {relTime(t.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
