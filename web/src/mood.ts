import type { Significance, Timeline, TLNode, Tone } from '../../shared/types.ts';

export const TONE_STYLE: Record<Tone, { color: string; label: string; icon: string }> = {
  neutral: { color: '#9d90ff', label: 'Neutral', icon: '◆' },
  conflict: { color: '#ff6b6b', label: 'Conflict', icon: '⚔' },
  catastrophe: { color: '#ff8f3f', label: 'Catastrophe', icon: '☄' },
  upheaval: { color: '#f7c948', label: 'Upheaval', icon: '⚡' },
  decline: { color: '#9aa7c2', label: 'Decline', icon: '⬇' },
  prosperity: { color: '#45d39a', label: 'Prosperity', icon: '✦' },
  discovery: { color: '#4cc3ff', label: 'Discovery', icon: '✧' },
  diplomacy: { color: '#e07cff', label: 'Diplomacy', icon: '⚖' },
};

export const SIGNIFICANCE_LABEL: Record<Significance, string> = {
  minor: 'Minor',
  notable: 'Notable',
  major: 'Major',
  pivotal: 'Pivotal',
};

export const isMajor = (n: TLNode) => n.kind === 'event' && (n.significance === 'major' || n.significance === 'pivotal');

export interface Mood {
  tone: Tone;
  color: string;
  /** 0 = neutral theme, 1 = fully recolored. */
  strength: number;
  /** The node the mood comes from. */
  source: TLNode | null;
  /** True when the mood announces a major node one step ahead of the selection. */
  foreshadow: boolean;
}

const NEUTRAL: Mood = { tone: 'neutral', color: TONE_STYLE.neutral.color, strength: 0, source: null, foreshadow: false };

const rank = (s: Significance) => ({ minor: 0, notable: 1, major: 2, pivotal: 3 })[s];

/**
 * The selected node sets the mood when it is major or pivotal. Otherwise, a major child of the selection
 * tints the theme faintly, as a warning of what is about to happen.
 */
export function moodFor(tl: Timeline | null, selected: TLNode | undefined): Mood {
  if (!tl || !selected) return NEUTRAL;
  if (isMajor(selected) && selected.status === 'ready') {
    return {
      tone: selected.tone,
      color: TONE_STYLE[selected.tone].color,
      strength: selected.significance === 'pivotal' ? 1 : 0.75,
      source: selected,
      foreshadow: false,
    };
  }
  const next = Object.values(tl.nodes)
    .filter((n) => n.parentId === selected.id && n.status === 'ready' && isMajor(n))
    .sort((a, b) => rank(b.significance) - rank(a.significance))[0];
  if (next) {
    return { tone: next.tone, color: TONE_STYLE[next.tone].color, strength: 0.4, source: next, foreshadow: true };
  }
  return NEUTRAL;
}
