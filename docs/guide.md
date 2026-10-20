# Using Forkpath

The same guide is built into the app: open **Guide** in the sidebar.

## Concepts

| Concept | Meaning |
|---|---|
| 🌊 Streams | Your branches, "Continue another way" and parallel threads are separate lines of events in **one shared world** (one per country, say). Streams can influence each other and merge. A stream can be renamed when its focus moves on |
| 🔀 Alternatives | When the model writes several possible outcomes with likelihoods, only one of them happens. Nothing under one alternative can influence anything under another |
| 🎲 Path odds | The chance history reaches a node: each fork's share for the outcome taken (scaled so a fork adds up to 100%), multiplied over every fork on the way. Shown in the side panel |
| 🎨 Significance and tone | Every node is minor, notable, major or pivotal, with a tone (conflict, catastrophe, upheaval, decline, prosperity, discovery, diplomacy, neutral). Selecting a major or pivotal node recolors the UI; the node before one shows an "ahead" warning. Re-rating in **Edit** does not mark later nodes stale |
| ⚠️ Stale | Editing a node marks everything after it, and everything it influences, as stale until you regenerate or keep it |

## Actions

| Action | How |
|---|---|
| 🌱 New timeline | Type a "What if" on the start page, or **+ New timeline** |
| ▶️ Continue | Hover a node and click **+**, or select it and use **Continue** (optional time span and guidance) |
| 🔀 Another continuation | **Continue another way** on a node that already has children; the model sees the existing ones |
| 🌿 Branch here | Describe a new change at that point, as an **Alternative** (separate branch) or a **Parallel thread** (alongside). The original path stays |
| ⇢ Influence | **Influence...** on a node, click 1-4 highlighted nodes in other streams, then **Influence N**. Pick a strength and optional guidance; the model writes a new event after each picked node, shaped by this one, with a dotted orange arrow |
| ⤚⤙ Merge | **Merge with...** on a node, click 1-4 nodes on separate branches, then **Merge N**. The model writes where the storylines meet; Branch A wins conflicts unless your guidance says otherwise |
| ✏️ Edit | Rewrite any field, including the stream name. Later and influenced nodes get marked **Stale** |
| ♻️ Regenerate, Keep | **Regenerate** rewrites a node to fit what came before (optional guidance). **Keep** or **Keep whole branch** clears the stale mark |
| 🔍 Review | Another writer checks the event for contradictions, anachronisms, unearned outcomes, causality gaps and numbers out of scale. The verdict and flags show in the panel, problems as a badge on the card; **Fix with Regenerate** sends the fixes as guidance. Editing or regenerating the event clears its review |
| ★ Most likely | Top bar toggle. Fades every node outside the most likely history: at each fork, the outcome the model rated highest |
| ⑂ Turning points | Top bar. A date-ordered list of every fork (with each outcome's share) and every pivotal event; click one to jump to it |
| ◷ Align by time | Top bar toggle. Columns follow each node's start date, so events in different branches line up. Remembered per timeline |
| 💾 Save branch, Export | **Save branch** in the side panel downloads the path to a node plus everything after it. **Export** in the top bar downloads the whole timeline |
| 📂 Import | **Import** in the sidebar opens a saved file as a new timeline (fresh ids, so importing twice is safe) |
| ⇤ Sidebar, ↔️ panel | The arrow next to the logo collapses the sidebar to an icon rail. Drag the side panel's left edge to resize it (double-click resets). Both are remembered |

## Generation options

Every Continue, Branch, Merge, Influence and Regenerate form has these, stored per request:

| Option | Choices |
|---|---|
| Time span | How far ahead the next event goes, e.g. "6 months" |
| Guidance | Free text the writer must follow |
| Temperament | **Realist** (default: incentives, capabilities and base rates decide), **Grim** or **Hopeful** (lean that way only when outcomes are close) |
| Narrative | **Beats** (default: dated bullet points that keep every fact an essay would, plus a "Why:" line) or **Full story** (prose paragraphs) |
| Plausibility review | **Off** (default), **Agent decides** (the writer flags the nodes it is unsure of) or **Every event**. Follow-ups inherit it |

## What the writer does on its own

- **Branches** into exclusive alternatives with likelihoods when the outcome is genuinely uncertain, and explains why.
- **Realism check** before writing: actors' incentives, capabilities and historical base rates, so outcomes are
  neither optimistic nor pessimistic by default.
- **Links** its event to events in other streams within 15 years, and can **search** older ones (old hits show
  only their key changes). It never links alternatives that exclude each other.
- **Follow-ups**: when an event hits another stream hard, it can request up to 2 events after that stream's latest
  one. They run as parallel jobs and cannot request more.
- **Renames a stream** when its focus has moved on (a "Vietnam War" thread that is now about Iran).
- Results are checked before anything is saved, and sent back for fixing when they break a rule: unknown
  fields, dates that run backwards or have no year, links or follow-ups to events that do not exist (or are
  not the latest in their stream), follow-ups from alternatives, an alternative with over 75% of the odds, or
  an INFLUENCE result without its note.
