import { useEffect, useMemo, useRef, useState } from 'react';
import type { Timeline } from '../../shared/types.ts';
import { cachedPlacement, placeNow, rememberPlacement, sortedNodes } from './layout.ts';
import { placementKey, provisionalPlacement, toPlaceNodes, type LayoutMode, type Placement } from './placement.ts';
import type { LayoutRequest, LayoutResponse } from './layout.worker.ts';

/** From this many nodes, a changed layout is computed in a worker (dagre takes ~0.1 s at 400, ~0.6 s at 2000). */
const WORKER_MIN = 400;

/**
 * Card positions for the canvas. Small timelines, unchanged structure, and the first layout of a timeline
 * are placed right away. When a big timeline's structure changes, dagre runs in a worker: meanwhile cards
 * keep their places and new ones sit next to their parent, then everything moves into the real layout.
 */
export function usePlacement(tl: Timeline, mode: LayoutMode): Placement {
  const all = useMemo(() => sortedNodes(tl), [tl]);
  const key = useMemo(() => placementKey(all, mode), [all, mode]);
  const shown = useRef<{ timelineId: string; placement: Placement } | null>(null);
  const worker = useRef<Worker | null>(null);
  const [arrived, setArrived] = useState<LayoutResponse | null>(null);

  const background = all.length >= WORKER_MIN && !cachedPlacement(key) && shown.current?.timelineId === tl.id;

  useEffect(() => {
    if (!background) return;
    if (!worker.current) {
      worker.current = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
      worker.current.onmessage = (e: MessageEvent<LayoutResponse>) => {
        rememberPlacement(e.data.key, e.data.placement);
        setArrived(e.data);
      };
    }
    const request: LayoutRequest = { key, nodes: toPlaceNodes(all), mode };
    worker.current.postMessage(request);
  }, [background, key, all, mode]);

  useEffect(() => () => worker.current?.terminate(), []);

  const placement = useMemo(() => {
    if (arrived?.key === key) return arrived.placement;
    if (background && shown.current) return provisionalPlacement(all, shown.current.placement);
    return placeNow(all, mode, key);
    // `arrived` is a dependency so the real layout replaces the stand-in when it lands.
  }, [all, mode, key, background, arrived]);

  useEffect(() => {
    shown.current = { timelineId: tl.id, placement };
  }, [tl.id, placement]);
  return placement;
}
