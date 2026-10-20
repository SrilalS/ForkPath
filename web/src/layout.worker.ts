// Runs dagre off the main thread for big timelines, so the canvas stays responsive while it works.
import { computePlacement, type LayoutMode, type PlaceNode, type Placement } from './placement.ts';

export interface LayoutRequest {
  key: string;
  nodes: PlaceNode[];
  mode: LayoutMode;
}
export interface LayoutResponse {
  key: string;
  placement: Placement;
}

self.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const { key, nodes, mode } = e.data;
  const response: LayoutResponse = { key, placement: computePlacement(nodes, mode) };
  self.postMessage(response);
};
