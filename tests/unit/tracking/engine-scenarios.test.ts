/**
 * End-to-end alignment scenarios (spec §31, §55.3): synthetic transcript
 * event sequences with expected cursor trajectories, driven by the JSON
 * fixtures in tests/fixtures/alignment/.
 */
import { describe, expect, it } from 'vitest';
import type { TrackingSnapshot } from '../../../src/shared/contracts/tracking';
import { AlignmentEngine } from '../../../src/shared/tracking/engine';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter, type SpeechTurn } from '../../fixtures/transcript-events/builder';

import normalRead from '../../fixtures/alignment/scenario-normal-read.json';
import hesitations from '../../fixtures/alignment/scenario-hesitations.json';
import adlibHold from '../../fixtures/alignment/scenario-adlib-hold.json';
import retake from '../../fixtures/alignment/scenario-retake.json';
import forwardSkip from '../../fixtures/alignment/scenario-forward-skip.json';
import repeatedRefrain from '../../fixtures/alignment/scenario-repeated-refrain.json';
import reacquisition from '../../fixtures/alignment/scenario-reacquisition.json';

interface Expectation {
  afterTurn: number;
  stateIn?: string[];
  nearWord?: string;
  occurrence?: number;
  tolerance?: number;
  /** Check committedTokenIndex instead of tokenIndex. */
  committed?: boolean;
  sawMovement?: string;
  forbidMovements?: string[];
}

interface Scenario {
  description: string;
  turns: SpeechTurn[];
  expect: Expectation[];
}

const scenarios: Scenario[] = [
  normalRead,
  hesitations,
  adlibHold,
  retake,
  forwardSkip,
  repeatedRefrain,
  reacquisition,
] as unknown as Scenario[];

function tokenIndexOf(word: string, occurrence: number): number {
  const document = demoDocument();
  let seen = 0;
  for (const token of document.spokenTokens) {
    if (token.normalized === word) {
      seen++;
      if (seen === occurrence) return token.index;
    }
  }
  throw new Error(`fixture word not found: ${word} (occurrence ${occurrence})`);
}

describe('alignment scenarios (§31)', () => {
  for (const scenario of scenarios) {
    it(scenario.description, () => {
      const engine = new AlignmentEngine(demoDocument(), {
        sessionId: 'session-1',
        sessionGeneration: 1,
        stageGeneration: 1,
      });
      const scripter = new TranscriptScripter(10_000, 1);

      const lastSnapshotPerTurn: Array<TrackingSnapshot | undefined> = [];
      const movementsPerTurn: string[][] = [];

      scenario.turns.forEach((turn) => {
        const movements: string[] = [];
        let last: TrackingSnapshot | undefined;
        for (const event of scripter.speak(turn)) {
          const output = engine.handleTranscriptEvent(event);
          if (output.snapshot) {
            last = output.snapshot;
            movements.push(output.snapshot.movement);
          }
        }
        lastSnapshotPerTurn.push(last ?? lastSnapshotPerTurn[lastSnapshotPerTurn.length - 1]);
        movementsPerTurn.push(movements);
      });

      for (const expectation of scenario.expect) {
        const snapshot = lastSnapshotPerTurn[expectation.afterTurn];
        expect(snapshot, `snapshot after turn ${expectation.afterTurn}`).toBeDefined();
        if (snapshot === undefined) continue;

        if (expectation.stateIn !== undefined) {
          expect(
            expectation.stateIn,
            `state after turn ${expectation.afterTurn} was ${snapshot.state}`,
          ).toContain(snapshot.state);
        }
        if (expectation.nearWord !== undefined) {
          const target = tokenIndexOf(expectation.nearWord, expectation.occurrence ?? 1);
          const actual = expectation.committed ? snapshot.committedTokenIndex : snapshot.tokenIndex;
          const tolerance = expectation.tolerance ?? 3;
          expect(
            Math.abs(actual - target),
            `cursor after turn ${expectation.afterTurn}: at ${actual}, expected near ` +
              `"${expectation.nearWord}" (${target}) ± ${tolerance}`,
          ).toBeLessThanOrEqual(tolerance);
        }
        if (expectation.sawMovement !== undefined) {
          const seen = movementsPerTurn.slice(0, expectation.afterTurn + 1).flat();
          expect(seen, `movement '${expectation.sawMovement}'`).toContain(expectation.sawMovement);
        }
        if (expectation.forbidMovements !== undefined) {
          const inTurn = movementsPerTurn[expectation.afterTurn] ?? [];
          for (const forbidden of expectation.forbidMovements) {
            expect(inTurn, `movement '${forbidden}' must not occur`).not.toContain(forbidden);
          }
        }
      }
    });
  }
});
