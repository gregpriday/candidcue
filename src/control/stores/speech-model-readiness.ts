/**
 * Whether the configured speech model can follow a voice take, kept current
 * (#301).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A STORE AND NOT A QUERY AT PRESENT
 * ---------------------------------------------------------------------------
 * The editor used to ask once, when a script opened, and keep the answer. Its
 * only refresh was a settings change — and installing, failing or removing a
 * model writes no setting. So a download that finished while a script was open
 * left the sheet saying "No speech model is installed" over a model Settings
 * showed as Installed, and a model removed in Settings left Present launching
 * with no warning into a take that then failed. Rust announces every one of
 * those changes on `speech://model-progress`; nothing in the editor listened.
 *
 * One answer, then, held here and followed from both directions: the event
 * stream for what happens to the model, the settings document for which model
 * is meant. Every way of starting a take reads it (`lib/check-then-start.ts`),
 * and so does the editor's footer, so the sheet and the line under the outline
 * cannot disagree.
 *
 * ---------------------------------------------------------------------------
 * WHICH EVENTS ARE OURS
 * ---------------------------------------------------------------------------
 * Settings holds the RECOGNISER id (`x-asr-480ms-streaming-…`); an event's
 * `modelId` is the short CATALOGUE id, and the two never compare equal. Its
 * `modelName` is the recogniser id — Rust fills it from the same
 * `ModelEntry::model_name` that `select_speech_language` persists — so that is
 * the field matched. Re-querying on every event would also work and would send
 * a status request per progress tick of a 161 MB download.
 *
 * Optimistic until Rust has answered, and after any failure to answer: an
 * unknown status must never invent a warning over a take that would have been
 * fine. The take path reports a genuinely missing model from the stage
 * regardless.
 */
import { derived, readable, type Readable } from 'svelte/store';
import {
  getSpeechModelStatus,
  isBusy,
  isDamaged,
  onSpeechModelProgress,
  type SpeechModelStatus,
} from '../services/speech-models';
import { settings } from './settings';

export interface SpeechModelReadiness {
  /** Rust has answered about the configured model. False means "assumed". */
  known: boolean;
  installed: boolean;
  /** Whether this build can load it at all, not whether it is present. */
  supported: boolean;
  /** Downloaded here and since damaged (#258) — see `isDamaged`. */
  damaged: boolean;
  /** An install of this model is running right now. */
  installing: boolean;
}

/** What is assumed before an answer, and after a failure to get one. */
export const ASSUMED_READY: SpeechModelReadiness = {
  known: false,
  installed: true,
  supported: true,
  damaged: false,
  installing: false,
};

function sameReadiness(a: SpeechModelReadiness, b: SpeechModelReadiness): boolean {
  return (
    a.known === b.known &&
    a.installed === b.installed &&
    a.supported === b.supported &&
    a.damaged === b.damaged &&
    a.installing === b.installing
  );
}

function fromStatus(status: SpeechModelStatus): SpeechModelReadiness {
  return {
    known: true,
    installed: status.installed,
    supported: status.supported,
    damaged: isDamaged(status),
    installing: isBusy(status),
  };
}

export interface SpeechModelReadinessSources {
  query: (recognizerId: string) => Promise<SpeechModelStatus>;
  listen: (handler: (status: SpeechModelStatus) => void) => Promise<() => void>;
}

/**
 * Build the store over a selected model id.
 *
 * Separate from the instance below so the ordering rules can be pinned without
 * a webview or a settings document.
 */
export function createSpeechModelReadiness(
  selected: Readable<string>,
  sources: SpeechModelReadinessSources = {
    query: getSpeechModelStatus,
    listen: onSpeechModelProgress,
  },
): Readable<SpeechModelReadiness> {
  return readable<SpeechModelReadiness>(ASSUMED_READY, (set) => {
    let disposed = false;
    let listening = false;
    let unlisten: (() => void) | null = null;
    let recognizerId: string | null = null;
    /*
     * The race, and its two guards. A status request and the event stream run
     * side by side: the request can be issued while an install is validating,
     * the install can finish and emit, and the older reply can then land on
     * top and strand the answer on a phase that is over — the same race
     * `reconcileModelStatuses` exists for in Settings. `events` counts what
     * arrived for the current model, and a reply is dropped if that moved while
     * it was in flight. `ticket` drops a reply for a model that is no longer
     * the one selected.
     */
    let events = 0;
    let ticket = 0;

    /*
     * Only a CHANGE is published. A download emits a status per progress
     * step, and every one of them reads "installing" here; notifying on each
     * would re-derive the editor's footer — an `aria-live` region — hundreds of
     * times to say the same thing.
     */
    let current: SpeechModelReadiness | null = null;
    const publish = (next: SpeechModelReadiness): void => {
      if (current !== null && sameReadiness(current, next)) return;
      current = next;
      set(next);
    };

    const refresh = (): void => {
      if (recognizerId === null) return;
      const mine = ++ticket;
      const seen = events;
      sources
        .query(recognizerId)
        .then((status) => {
          if (disposed || mine !== ticket || events !== seen) return;
          publish(fromStatus(status));
        })
        .catch(() => {
          // Unknown keeps whatever was known about THIS model. See the header.
        });
    };

    const stopSelection = selected.subscribe((id) => {
      if (id === recognizerId) return;
      recognizerId = id;
      events = 0;
      ticket += 1;
      // The previous model's answer is not this one's.
      publish(ASSUMED_READY);
      // Before the listener is attached the query would race the very events
      // it needs to be reconciled with; the attach below issues it instead.
      if (listening) refresh();
    });

    /*
     * Subscribed FIRST, then the snapshot. The other order loses a terminal
     * event that lands between the reply and the attach, and nothing would
     * ever move the answer off "installing".
     */
    sources
      .listen((status) => {
        if (disposed || status.modelName !== recognizerId) return;
        events += 1;
        publish(fromStatus(status));
      })
      .then((stop) => {
        // The attach can outlive the last subscriber; without this it leaks.
        if (disposed) stop();
        else unlisten = stop;
      })
      // A bus that will not open is no reason for an unhandled rejection. The
      // answer is still read once — it just will not follow.
      .catch(() => {})
      .finally(() => {
        listening = true;
        if (!disposed) refresh();
      });

    return () => {
      disposed = true;
      ticket += 1;
      stopSelection();
      unlisten?.();
      unlisten = null;
    };
  });
}

/**
 * The configured model's readiness, for the control window.
 *
 * Live while anything subscribes. The shell holds a subscription for the life
 * of the window (`App.svelte`), so a launch from a route that shows none of
 * this — the Library, the summary's Present again — still reads a current
 * answer through `get()` rather than starting a listener that answers
 * "assumed" and stops.
 */
export const speechModelReadiness = createSpeechModelReadiness(
  derived(settings, (s) => s.speech.transcriptionModel),
);
