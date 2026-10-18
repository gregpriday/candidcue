<!--
  Notes on how a script will read out loud — the advisory lint from
  `lib/script-lint.ts`, surfaced in the editor rail.

  Advisory means advisory, and the surface has to say so before the copy does.
  There is no badge, no severity colour, nothing that reads as stop, and no
  path from here into Present. A presenter who is about to record must never be
  argued with about prose, so the loudest this is ever allowed to be is a
  collapsed row saying how many notes there are — and when there are none it
  renders nothing at all. A standing "0 notes" row is still an accusation that
  the script is being marked.

  Open, it is a short list of the kinds of note with a count each, not a list
  of every note. Each note used to carry its rule's whole explanation, so one
  note filled the rail and a shot list typed without full stops was twenty-five
  copies of the same paragraph with a different line number under each. Now a
  rule says what to do, and why, once; its notes are quotes of the words they
  are about, so they can be told apart without following each one to find out.

  The disclosure is written here rather than reused from `Disclosure.svelte`
  because that one carries the settings page's rhythm and owns its own
  horizontal edges. The rail needs a full-bleed seam (to match `.panel-foot`
  above the compile status) with its text inset to the rail's 16px gutter, and
  reaching in to move those from outside would mean styling another component's
  private class names. Same `<details>`, same chevron, rail density.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import type { ScriptLintCode, ScriptLintFinding } from '../lib/script-lint';

  interface Props {
    findings: ScriptLintFinding[];
    /** Reveal a finding's run in the editor. */
    ongoto?: (finding: ScriptLintFinding) => void;
  }

  let { findings, ongoto }: Props = $props();
  const uid = $props.id();

  let expanded = $state(false);

  interface Rule {
    /** One note's name, for a screen reader announcing a single row. */
    one: string;
    /** The heading over however many there are; the count sits beside it. */
    many: string;
    /** What to do — the half of the note the author can act on. */
    action: string;
    /**
     * Why it matters, in one sentence, behind "Why this helps". Folded away
     * because it was the one thing standing between an opened rule and its
     * places: at the rail's narrowest it pushed every quote below the fold.
     */
    why: string;
  }

  /*
   * The rail's own words for each rule. They live here and not in
   * `script-lint.ts` because that file's `message` is a note about ONE place —
   * "this sentence runs to 70 spoken words" — and a heading over all of them is
   * a different job with a different budget.
   *
   * Typed as a total record on purpose: a lint code cannot be added upstream
   * without this failing to compile, which is the only thing standing between
   * a new rule and a heading that says `undefined`.
   */
  const RULES: Record<ScriptLintCode, Rule> = {
    'long-paragraph': {
      one: 'Long paragraph',
      many: 'Long paragraphs',
      action: 'Split it with a blank line at a natural pause.',
      why: 'Tracking finds you again within a paragraph, so a shorter one is less to search if you skip or repeat a line.',
    },
    'very-long-sentence': {
      one: 'Long sentence',
      many: 'Long sentences',
      action: 'Split it at the breath you would actually take.',
      why: 'Sentence endings give the display and the tracker a place to settle.',
    },
    'no-terminal-punctuation': {
      one: 'Missing full stop',
      many: 'Missing full stops',
      action: 'End it with a full stop, even where you would not pause.',
      why: 'The closing mark tells the display and the tracker that the thought is finished.',
    },
    'all-caps-run': {
      one: 'Run of capitals',
      many: 'Runs of capitals',
      action: 'Use sentence case, and carry the emphasis with bold or a cue.',
      why: 'Capitals are slower to read aloud: every word is the same flat shape.',
    },
  };

  /*
   * Rules in the order they cost a take, not the order they happen to appear:
   * the two that bound how far tracking has to search first. A fixed order also
   * keeps a heading from changing places while the author works through it.
   */
  const ORDER: ScriptLintCode[] = [
    'long-paragraph',
    'very-long-sentence',
    'no-terminal-punctuation',
    'all-caps-run',
  ];

  const groups = $derived(
    ORDER.map((code) => ({ code, findings: findings.filter((f) => f.code === code) })).filter(
      (group) => group.findings.length > 0,
    ),
  );

  const summary = $derived(
    findings.length === 1 ? '1 reading note' : `${findings.length} reading notes`,
  );

  /*
   * Which rules are open, by code, so a recompile — every pause in typing —
   * does not fold up the one the author is working through.
   *
   * Every rule starts closed, so opening the panel shows the whole inventory —
   * each kind of note and how many — before any one of them. Opening a rule
   * with one note in it used to look like a shortcut, and in a shot list it
   * spent the rail on the one long sentence while the heading over the other
   * twenty-five sat below the fold. The exception is a panel with a single note
   * in it, where the heading would be a click that buys nothing.
   */
  let ruleOpen = $state<Partial<Record<ScriptLintCode, boolean>>>({});
  const isOpen = (code: ScriptLintCode) => ruleOpen[code] ?? findings.length === 1;

  function onRuleToggle(code: ScriptLintCode, rule: HTMLDetailsElement): void {
    ruleOpen[code] = rule.open;
    if (rule.open) requestAnimationFrame(() => showFirstPlace(rule));
  }

  /*
   * Opening a rule brings its first place fully into view.
   *
   * In a short window the rule's heading and action could fill what was left
   * of the list, so opening "Long sentences" showed the advice and half a
   * quote, and the author still had to scroll to find out where the first one
   * was. The list moves only as far as that first row needs, and never past
   * the rule's own heading — the preamble and the rules above it are what give
   * way. Only on opening: a recompile does not toggle anything, so it never
   * moves the list under someone reading it.
   */
  function showFirstPlace(rule: HTMLDetailsElement): void {
    const body = rule.closest<HTMLElement>('.body');
    const head = rule.querySelector('summary');
    const first = rule.querySelector('.finding');
    if (!body || !head || !first) return;
    const view = body.getBoundingClientRect();
    const overflow = first.getBoundingClientRect().bottom - view.bottom;
    if (overflow <= 0) return;
    const headroom = head.getBoundingClientRect().top - view.top;
    body.scrollTop += Math.min(overflow + 8, Math.max(0, headroom));
  }

  /* ------------------------------------------------- the note followed */

  /*
   * The note the author last followed, so they can find their place in the
   * list again. Keyed by rule and position rather than by index, since two
   * rules can land on one line; once an edit resolves the note, or moves it,
   * the key matches nothing and the mark simply goes.
   */
  const keyOf = (f: ScriptLintFinding) => `${f.code}:${f.line}:${f.column ?? 0}`;
  let followed = $state<string | null>(null);

  /*
   * Escape in the editor comes back to that note — the keyboard's way back to
   * the list, which otherwise sits behind the whole outline in the tab order.
   * Armed by following a note and disarmed as soon as focus goes anywhere but
   * the editor, so the key only ever means this straight after a jump. Escape
   * is otherwise free in a text field here (`lib/shortcuts.ts` stands down
   * while typing), and anything that claims it first — the search panel, a
   * selection collapsing — has already prevented it by the time it bubbles up.
   */
  let returnArmed = $state(false);

  /*
   * Where in its rule the followed note sat. Fixing the note is the whole
   * point of following it, and the fix is exactly what makes its key match
   * nothing — so Escape after a fix used to land on the panel's summary, as
   * far from the author's place as the list goes. It comes back to whatever
   * has taken that slot instead: the next note of the same kind, or the one
   * before it when the fixed note was the last.
   */
  let followedSlot: { code: ScriptLintCode; index: number } | null = null;

  let section = $state<HTMLElement>();

  function follow(finding: ScriptLintFinding): void {
    followed = keyOf(finding);
    const sameRule = findings.filter((f) => f.code === finding.code);
    followedSlot = { code: finding.code, index: Math.max(0, sameRule.indexOf(finding)) };
    returnArmed = true;
    ongoto?.(finding);
  }

  /** The note Escape comes back to: the one followed, or the one in its place. */
  function returnTarget(): ScriptLintFinding | null {
    const exact = findings.find((f) => keyOf(f) === followed);
    if (exact || !followedSlot) return exact ?? null;
    const { code, index } = followedSlot;
    const sameRule = findings.filter((f) => f.code === code);
    return sameRule[Math.min(index, sameRule.length - 1)] ?? null;
  }

  function inEditor(node: EventTarget | null): boolean {
    return node instanceof Element && node.closest('.cm-editor') !== null;
  }

  async function onKeydown(event: KeyboardEvent): Promise<void> {
    if (!returnArmed || event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (!inEditor(document.activeElement)) return;
    event.preventDefault();
    returnArmed = false;
    expanded = true;
    const target = returnTarget();
    if (target) ruleOpen[target.code] = true;
    await tick();
    const row = target && section?.querySelector<HTMLElement>(`[data-note="${keyOf(target)}"]`);
    (row ?? section?.querySelector<HTMLElement>('summary'))?.focus();
  }

  function onFocusIn(event: FocusEvent): void {
    if (returnArmed && !inEditor(event.target)) returnArmed = false;
  }

  /* ------------------------------------------------------- the budget */

  /*
   * Open, the panel may take at most 45% of the rail (and never more than
   * 300px): the outline above it is the reason the rail exists, and at the
   * smallest window an uncapped panel left it three headings. The cap is a
   * ceiling, not a reservation — a short list takes only what it needs.
   *
   * Measured from the rail rather than taken from the viewport, because the
   * rail is what is being shared and `vh` counts the toolbars too.
   */
  let railHeight = $state(0);
  let summaryHeight = $state(0);

  $effect(() => {
    const rail = section?.parentElement;
    if (!rail || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      railHeight = entry?.contentRect.height ?? 0;
    });
    observer.observe(rail);
    return () => observer.disconnect();
  });

  const bodyMax = $derived(
    railHeight > 0 ? `${Math.max(120, Math.min(300, railHeight * 0.45) - summaryHeight)}px` : undefined,
  );
</script>

<svelte:window onkeydown={onKeydown} onfocusin={onFocusIn} />

{#if findings.length > 0}
  <section class="lint" aria-label="Reading notes" bind:this={section}>
    <details bind:open={expanded}>
      <summary class="summary" bind:offsetHeight={summaryHeight}>
        <span class="chevron" class:rotated={expanded}>
          <Icon name="chevron-right" size={14} />
        </span>
        <span>{summary}</span>
      </summary>
      <div class="body" style:max-height={bodyMax}>
        <p class="preamble">Suggestions for reading aloud. None of them blocks a take.</p>
        <!-- Said once, before a note is ever followed: the visible "Esc to come
             back" only appears after focus has already left for the editor,
             which is exactly where a screen reader cannot see it. -->
        <p id="{uid}-how" class="sr-only">
          Opens the place in the editor. Press Escape there to come back to this note.
        </p>
        {#each groups as group (group.code)}
          {@const rule = RULES[group.code]}
          {@const open = isOpen(group.code)}
          <details
            class="rule"
            {open}
            ontoggle={(event) => onRuleToggle(group.code, event.currentTarget)}
          >
            <summary class="rule-head">
              <span class="chevron" class:rotated={open}>
                <Icon name="chevron-right" size={14} />
              </span>
              <span class="rule-name">{group.findings.length === 1 ? rule.one : rule.many}</span>
              <span class="count">{group.findings.length}</span>
            </summary>
            <div class="rule-body">
              <p class="action">{rule.action}</p>
              <details class="why">
                <summary class="why-head">
                  <span class="chevron small"><Icon name="chevron-right" size={12} /></span>
                  <span>Why this helps</span>
                </summary>
                <p class="why-text">{rule.why}</p>
              </details>
              <ul class="findings">
                <!-- Deliberately keyless: two rules can land on the same line, and a
                     duplicate key is a thrown error in the middle of someone's
                     editor. These rows are static text, so keying buys nothing. -->
                {#each group.findings as finding}
                  {@const current = followed === keyOf(finding)}
                  <li>
                    <button
                      type="button"
                      class="finding"
                      class:current
                      class:firm={finding.severity === 'warn'}
                      data-note={keyOf(finding)}
                      aria-describedby="{uid}-how"
                      onclick={() => follow(finding)}
                    >
                      <span class="sr-only">{rule.one}: </span>
                      <span class="excerpt">{finding.excerpt ?? rule.one}</span>
                      <span class="where">
                        <span>
                          line {finding.line}{#if finding.words}<span aria-hidden="true">{' · '}</span
                            ><span class="sr-only">, </span>{finding.words} words{/if}
                        </span>
                        {#if current && returnArmed}
                          <span class="return" aria-hidden="true">Esc to come back</span>
                        {/if}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          </details>
        {/each}
      </div>
    </details>
  </section>
{/if}

<style>
  .lint {
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
  }

  .summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    cursor: pointer;
    list-style: none;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .summary::-webkit-details-marker,
  .rule-head::-webkit-details-marker {
    display: none;
  }
  .summary:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }

  .chevron {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-muted);
    transition: transform var(--dur-med) var(--ease-out);
  }
  .rotated {
    transform: rotate(90deg);
  }

  /* Same text edge as the outline above it: every row carries a 10px inset
     for its hover pill, so the container gives that much back rather than
     stacking a second full-width padding on top of it. The preamble scrolls
     with the rules, so a scrolled list never slides under it. */
  .body {
    --rail-pill-inset: 10px;
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 calc(var(--space-4) - var(--rail-pill-inset)) var(--space-3);
    overflow-y: auto;
  }

  .preamble {
    margin: 0 0 var(--space-2);
    padding: 0 var(--rail-pill-inset);
    font-size: var(--text-2xs);
    line-height: var(--lh-meta);
    color: var(--text-faint);
  }

  /* A rule heading is an outline row: same height, weight, pill and meta. */
  .rule-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 30px;
    padding: var(--space-1) var(--rail-pill-inset);
    border-radius: var(--radius-sm);
    cursor: pointer;
    list-style: none;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .rule-head:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }
  .rule-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex: 0 0 auto;
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* Indented by the chevron and its gap, so a rule's text lines up under its
     name the way the outline's sections line up under their part. */
  .rule-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 0 var(--space-3) calc(14px + var(--space-2));
  }

  /* The half the author can act on carries the warm accent — `--accent-strong`
     because small terracotta text needs it to clear AA on the light paper. */
  .action,
  .why-text {
    margin: 0;
    padding: 0 var(--rail-pill-inset);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
  }
  .action {
    color: var(--accent-strong);
  }

  /* The reason, on request: a meta-sized disclosure under the action, so an
     opened rule reaches its places first and explains itself second. */
  .why-head {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    min-height: 24px;
    padding: 0 var(--rail-pill-inset);
    border-radius: var(--radius-sm);
    cursor: pointer;
    list-style: none;
    font-size: var(--text-2xs);
    color: var(--text-faint);
    transition: color var(--dur-fast) var(--ease-out);
  }
  .why-head::-webkit-details-marker {
    display: none;
  }
  .why-head:hover {
    color: var(--text-primary);
  }
  .why[open] > .why-head .chevron {
    transform: rotate(90deg);
  }
  .chevron.small {
    color: inherit;
  }
  .why-text {
    padding-bottom: var(--space-1);
    color: var(--text-faint);
  }

  .findings {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .finding {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 6px var(--rail-pill-inset);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .finding:hover {
    background: var(--bg-hover-chrome);
  }
  /* The note last followed: the rail's selected-row pill, so the author can
     find their place again after a jump. The editor marks the same run. */
  .finding.current {
    background: var(--bg-panel);
    border-color: var(--border-faint);
    box-shadow: var(--shadow-card);
  }

  /* A quote of the words themselves — two lines at most, so a long paragraph
     costs the list no more than a short one. */
  .excerpt {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  /* `warn` is one step of contrast, not a colour that means anything. The lint
     raises its voice by being easier to read, never by turning amber. */
  .finding.firm .excerpt,
  .finding.current .excerpt {
    color: var(--text-primary);
  }

  .where {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--text-2xs);
    line-height: 15px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .return {
    flex: 0 0 auto;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>
