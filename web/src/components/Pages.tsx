import { useRef, type ReactNode } from 'react';
import { SCHEMA_VERSION, SIGNIFICANCES, TONES } from '../../../shared/types.ts';
import { INFLUENCE_OVERLAP_YEARS, INFLUENCE_WINDOW_YEARS } from '../../../shared/world.ts';
import { SIGNIFICANCE_LABEL, TONE_STYLE } from '../mood.ts';

/** A long-form page in the main area with an optional table of contents. */
function DocPage({ title, lead, toc, children }: { title: string; lead: string; toc?: [string, string][]; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className="doc" ref={root}>
      <div className="doc__inner">
        <header className="doc__head">
          <h1>{title}</h1>
          <p className="doc__lead">{lead}</p>
        </header>
        {toc && (
          <nav className="doc__toc" aria-label="On this page">
            {toc.map(([id, label]) => (
              <button
                key={id}
                className="chip"
                // The URL hash is the app's router, so jump with scrollIntoView instead of #anchors.
                onClick={() => {
                  const el = root.current?.querySelector<HTMLElement>(`#${id}`);
                  // .doc is the scroll container and the sections' offsetParent.
                  if (el) root.current!.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' });
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        {children}
      </div>
    </div>
  );
}

function Section({ id, icon, title, children }: { id: string; icon: string; title: string; children: ReactNode }) {
  return (
    <section className="doc__section" id={id}>
      <h2>
        <span className="doc__icon" aria-hidden>
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A row of the glossary: a term, a small visual sample, and what it means. */
function Term({ name, sample, children }: { name: string; sample?: ReactNode; children: ReactNode }) {
  return (
    <div className="doc__term">
      <div className="doc__term-name">
        <strong>{name}</strong>
        {sample}
      </div>
      <div className="doc__term-body">{children}</div>
    </div>
  );
}

const SIGNIFICANCE_HELP: Record<(typeof SIGNIFICANCES)[number], string> = {
  minor: 'Local or short-lived effects, consolidation, quiet years.',
  notable: 'Real change within the existing order. The default.',
  major: 'Wars, revolutions, collapses or breakthroughs that reshape a region or field. Recolors the UI.',
  pivotal: 'A turning point for the whole world or era. Rare. Recolors the UI fully.',
};

const TONE_HELP: Record<(typeof TONES)[number], string> = {
  neutral: 'Mixed or administrative; no single character.',
  conflict: 'War, armed struggle, violent rivalry.',
  catastrophe: 'Plague, famine, disaster, collapse with mass suffering.',
  upheaval: 'Revolution, coup, radical social or religious change.',
  decline: 'Slow decay, stagnation, loss of power.',
  prosperity: 'Growth, golden ages, stability.',
  discovery: 'Exploration, science, invention, new contact.',
  diplomacy: 'Treaties, alliances, unions, negotiated settlements.',
};

export function GuidePage() {
  return (
    <DocPage
      title="Guide"
      lead="How AltHistory works, what everything on screen means, and what each action does."
      toc={[
        ['how', 'How it works'],
        ['canvas', 'Reading the map'],
        ['structure', 'Streams and alternatives'],
        ['actions', 'Actions'],
        ['ratings', 'Significance and tone'],
        ['rules', 'Rules'],
        ['worker', 'The worker'],
        ['files', 'Saving and files'],
      ]}
    >
      <Section id="how" icon="🧭" title="How it works">
        <p>
          You describe one change to history, the <strong>point of divergence</strong>. A language model then writes what happens
          next, one event at a time. Every event is a card (a <strong>node</strong>) on a map that branches as the history does.
        </p>
        <div className="doc__flow">
          <div className="doc__flow-step">
            <strong>1. Diverge</strong>
            <span>Describe a change</span>
          </div>
          <div className="doc__flow-step">
            <strong>2. Generate</strong>
            <span>The model writes the next event</span>
          </div>
          <div className="doc__flow-step">
            <strong>3. Shape</strong>
            <span>Edit, branch, merge, influence</span>
          </div>
          <div className="doc__flow-step">
            <strong>4. Continue</strong>
            <span>Repeat from any node</span>
          </div>
        </div>
        <p>
          The model is a Claude Code session (the <strong>worker</strong>) that picks up jobs from this app. When you ask for a new
          event, a placeholder card appears and fills in once the worker is done. Everything updates live.
        </p>
      </Section>

      <Section id="canvas" icon="🗺️" title="Reading the map">
        <p>Time flows left to right. Click a card to open it in the side panel; hover it and click + to continue from it.</p>
        <div className="doc__terms">
          <Term name="Point of divergence" sample={<span className="tl-chip">Divergence</span>}>
            The first card: the change you described. Everything else follows from it.
          </Term>
          <Term name="Event">
            A card the model wrote. It has a <em>title</em>, a <em>period</em> (when it happens), a <em>summary</em> (shown on
            the card), a <em>narrative</em> (the full account in the side panel: dated beats with a closing &quot;Why&quot;, or prose
            if you asked for a full story) and <em>key changes</em> (how this world now
            differs from ours).
          </Term>
          <Term name="Branch" sample={<span className="tl-chip">Deviation</span>}>
            A change you introduced partway through, with <strong>Branch here</strong>. The original path stays as it was.
          </Term>
          <Term name="Likelihood" sample={<span className="doc__pill">62%</span>}>
            When the model is genuinely unsure, it writes 2 to 4 possible outcomes instead of one. Each shows its estimated
            probability on the edge and card, and the side panel explains why it split (the <em>branch reason</em>).
          </Term>
          <Term name="Thread" sample={<span className="tl-chip tl-chip--thread">🧵 Thread</span>}>
            A parallel storyline that happens alongside the others, with its own color, such as a neighboring country&apos;s
            politics or a space program. When a stream&apos;s story moves on, rename it from any later card with{' '}
            <strong>Edit</strong> (&quot;Stream name from here on&quot;); the model can do the same. The color stays.
          </Term>
          <Term name="Convergence" sample={<span className="tl-chip tl-chip--merge">Convergence</span>}>
            A card with two or more parents, joined by teal dotted lines: the point where separate storylines meet (made with
            Merge).
          </Term>
          <Term name="Influence" sample={<span className="doc__arrow">⇢</span>}>
            A dotted orange arrow: one event shapes another in a different stream, without being its parent. Thicker means
            stronger (mild, moderate, strong). Hover the label to read how.
          </Term>
          <Term name="Generating" sample={<span className="doc__pill">Writing...</span>}>
            A placeholder waiting for the worker. You can cancel it from the side panel.
          </Term>
          <Term name="Stale" sample={<span className="tl-badge tl-badge--stale">Stale</span>}>
            Something earlier changed (you edited an ancestor, or an event that influences this one), so this card may no longer
            fit. Regenerate it, or keep it as it is.
          </Term>
          <Term name="Edited" sample={<span className="tl-badge">Edited</span>}>
            You changed what the model wrote. The model treats your edits as fact from then on.
          </Term>
        </div>
      </Section>

      <Section id="structure" icon="🌿" title="Streams and alternatives">
        <p>Branches can mean two different things, and the app keeps them apart:</p>
        <div className="doc__cards">
          <div className="doc__card">
            <h3>🌊 Streams (all happen)</h3>
            <p>
              Your branches, &quot;continue another way&quot; and threads are <strong>streams</strong>: separate lines of events in
              one shared world, for example one per country. Streams can influence each other and can be merged.
            </p>
          </div>
          <div className="doc__card">
            <h3>🔀 Alternatives (only one happens)</h3>
            <p>
              When the model returns several outcomes with likelihoods, those are <strong>exclusive alternatives</strong>: if one
              happens, the others do not. Nothing under one alternative can influence anything under another.
            </p>
            <p>
              A card&apos;s <strong>path odds</strong> multiply the share of every alternative taken on the way to it (each fork&apos;s
              numbers are scaled to add up to 100%). They show in the side panel.
            </p>
          </div>
        </div>
      </Section>

      <Section id="actions" icon="🛠️" title="Actions">
        <div className="doc__table">
          <div className="doc__row doc__row--head">
            <span>Action</span>
            <span>Where</span>
            <span>What it does</span>
          </div>
          {(
            [
              [
                '▶️ Continue',
                '+ on a card, or side panel',
                'The model writes the next event. Optional time span (or Auto), guidance, temperament (Realist by default; Grim or Hopeful tip close calls) and narrative format (dated Beats by default, or Full story).',
              ],
              ['🔁 Continue another way', 'Side panel, on a card that already continues', 'Another possible next event; the model sees the existing ones and writes something different.'],
              ['🌿 Branch here', 'Side panel', 'You describe a new change at this point. Choose Alternative (a separate branch) or Parallel thread.'],
              ['✏️ Edit', 'Side panel', 'Rewrite any field. Later events and the events this one influences are marked stale. Re-rating significance or tone does not.'],
              ['♻️ Regenerate', 'Side panel or stale banner', 'The model rewrites this card to fit what came before, with optional guidance.'],
              ['✅ Keep', 'Stale banner', 'Clear the stale mark on this card, or on the whole branch after it.'],
              ['⤚⤙ Merge with...', 'Side panel', 'Click 1 to 4 cards on other branches, then Merge. The model writes where they meet; Branch A wins conflicts unless your guidance says otherwise.'],
              ['⇢ Influence...', 'Side panel', 'Click 1 to 4 cards in other streams, then Influence. Set the strength and guidance; the model writes a new event after each picked card, shaped by this one.'],
              ['🗑️ Delete', 'Side panel', 'Removes the card and everything after it.'],
              ['◷ Align by time', 'Top bar', 'Lines cards up in columns by start year, so events in different branches that happen at the same time sit side by side.'],
              ['★ Most likely', 'Top bar', 'Fades every card outside the most likely history: at each fork, the outcome the model rated highest. Streams in that world stay lit.'],
              ['⑂ Turning points', 'Top bar', 'A date-ordered list of every fork (with each outcome\'s share) and every pivotal event. Click one to jump to it.'],
            ] as const
          ).map(([a, w, d]) => (
            <div className="doc__row" key={a}>
              <strong>{a}</strong>
              <span className="muted">{w}</span>
              <span>{d}</span>
            </div>
          ))}
        </div>
        <p className="muted small">Esc cancels a pick (merge or influence) and closes dialogs. Ctrl+Enter submits the start page and the Regenerate form. Drag the side panel&apos;s left edge to resize it; double-click to reset.</p>
      </Section>

      <Section id="ratings" icon="🎨" title="Significance and tone">
        <p>
          Every event has a <strong>significance</strong> (how much it changes history) and a <strong>tone</strong> (its dominant
          character). Selecting a major or pivotal event recolors the whole interface in its tone (the <strong>mood</strong>).
          Selecting the event just before one gives a faint tint and an &quot;ahead&quot; pill, as a warning.
        </p>
        <div className="doc__terms">
          {SIGNIFICANCES.map((s) => (
            <Term key={s} name={SIGNIFICANCE_LABEL[s]}>
              {SIGNIFICANCE_HELP[s]}
            </Term>
          ))}
        </div>
        <div className="doc__tones">
          {TONES.map((t) => (
            <div key={t} className="doc__tone" style={{ '--tone': TONE_STYLE[t].color } as React.CSSProperties}>
              <span className="doc__tone-icon">{TONE_STYLE[t].icon}</span>
              <div>
                <strong>{TONE_STYLE[t].label}</strong>
                <span className="muted small">{TONE_HELP[t]}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="muted small">
          The model aims for roughly 20% minor, 55% notable, 20% major and at most 5% pivotal, so the mood stays meaningful. You
          can re-rate any event in Edit.
        </p>
      </Section>

      <Section id="rules" icon="📏" title="Rules the app enforces">
        <ul className="doc__list">
          <li>
            <strong>Time only moves forward.</strong> A new event cannot start before the event it follows (or, for a merge or
            influence, before any of the events involved). The model has to fix such results before they are saved.
          </li>
          <li>
            <strong>Influences stay plausible.</strong> An event cannot influence one that started more than{' '}
            {INFLUENCE_OVERLAP_YEARS} years before it, or one on its own path (that is already cause and effect), or one under a
            different exclusive alternative.
          </li>
          <li>
            <strong>The model looks around, not everywhere.</strong> When writing an event, it is shown events in other streams
            within {INFLUENCE_WINDOW_YEARS} years and can search for older ones (old ones show only their key changes). Its own
            new event can influence existing events at most {INFLUENCE_WINDOW_YEARS} years ahead.
          </li>
          <li>
            <strong>Follow-ups go one level deep.</strong> When a new event hits another stream hard, the model can ask for up to
            2 follow-up events there (added after that stream&apos;s latest event, with an arrow from the cause). They generate on
            their own and can be cancelled like any placeholder. A follow-up never requests more follow-ups.
          </li>
          <li>
            <strong>Your edits are canon.</strong> Anything you wrote or edited is treated as fact by every later generation.
          </li>
        </ul>
      </Section>

      <Section id="worker" icon="🤖" title="The worker">
        <p>
          There is no API key. A separate <strong>Claude Code session</strong> acts as the model. It waits for jobs and hands
          each one to a fresh <strong>writer subagent</strong>, which reads the brief (the history so far, your guidance, nearby
          events), writes the result and submits it. Up to 3 jobs run at once. The sidebar card shows its state:
        </p>
        <div className="doc__terms">
          <Term name="Worker online" sample={<span className="dot dot--on" />}>
            The session is polling or busy with a job. Requests are picked up right away.
          </Term>
          <Term name="Worker offline" sample={<span className="dot dot--off" />}>
            No session is running. You can still queue requests; they wait until a worker connects.
          </Term>
          <Term name="Backend offline">The app server is not running. Start it with npm run dev.</Term>
        </div>
        <p>To start a worker, open a new Claude Code session in the project folder and send:</p>
        <pre className="doc__code">
          You are the AltHistory worker. Read `worker/WORKER.md` and follow it exactly. Start the job loop now and keep it running
          until I tell you to stop.
        </pre>
        <p className="muted small">After the app is updated, restart the worker session so it re-reads its instructions.</p>
        <p>
          <strong>No Claude Code?</strong> In <strong>Settings</strong>, switch the engine to <strong>Built-in model API</strong>:
          the app then calls a model itself (Anthropic, OpenAI, Gemini, OpenRouter, or a local Ollama / LM Studio). Results follow
          the same rules. Settings also tracks tokens and cost, and can cap monthly spending. The bottom of each card&apos;s side
          panel shows which model wrote it.
        </p>
      </Section>

      <Section id="files" icon="💾" title="Saving and files">
        <ul className="doc__list">
          <li>Everything saves automatically, on this computer, in the project&apos;s data folder.</li>
          <li>
            <strong>Export</strong> (top bar) downloads the whole timeline. <strong>Save branch</strong> (side panel) downloads
            the path to a card plus everything after it.
          </li>
          <li>
            <strong>Import</strong> (sidebar) opens a saved file as a new timeline with fresh ids, so importing twice is safe.
          </li>
          <li>Files from older versions of the app are upgraded automatically when opened.</li>
        </ul>
      </Section>
    </DocPage>
  );
}

export function AboutPage() {
  return (
    <DocPage title="About" lead="AltHistory is a branching alternate-history modeler: one change to history, and a map of where it leads.">
      <Section id="what" icon="🌍" title="What it is">
        <p>
          AltHistory lets you explore &quot;what if&quot; questions as a living map instead of a single story. A language model
          writes the consequences of your change event by event, branches where outcomes are genuinely uncertain, and keeps
          separate storylines (regions, programs, movements) apart until you merge them or let them influence each other.
        </p>
        <p>
          You stay in control: every event can be edited, regenerated, kept, branched or deleted, and your edits become fact for
          everything that follows.
        </p>
      </Section>

      <Section id="how-built" icon="⚙️" title="How it is built">
        <div className="doc__table doc__table--two">
          {(
            [
              ['Interface', 'React, React Flow (the map) and dagre (layout)'],
              ['Server', 'Node.js and Express, with live updates over server-sent events'],
              ['Model', 'Your choice in Settings: a Claude Code worker session, or a model API (Anthropic or any OpenAI-compatible server, local ones included)'],
              ['Storage', 'JSON files on this computer, one per timeline'],
              ['File format', `Version ${SCHEMA_VERSION}, with automatic upgrades from older versions`],
            ] as const
          ).map(([k, v]) => (
            <div className="doc__row" key={k}>
              <strong>{k}</strong>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="privacy" icon="🔒" title="Your data">
        <p>
          Timelines stay on this computer. The only thing that reads them is the engine you choose: the worker session you
          start yourself, or the model API you set up in Settings. Either one sees only the brief for each job it handles.
        </p>
      </Section>

      <Section id="author" icon="👤" title="Made by">
        <p>
          AltHistory is designed and built by <strong>Srilal Siriwardhane</strong>.
        </p>
        <p>
          It is open source under the <strong>MIT License</strong>: you can use, change and share it freely, as long as the
          copyright notice stays with it. It comes with no warranty. The full text is in the <code>LICENSE</code> file.
        </p>
      </Section>

      <Section id="limits" icon="⚠️" title="Keep in mind">
        <ul className="doc__list">
          <li>This is speculative fiction. Events, people&apos;s choices and numbers in a timeline are invented.</li>
          <li>The model can be wrong about real history before the divergence. Edit anything that looks off.</li>
        </ul>
      </Section>
    </DocPage>
  );
}
