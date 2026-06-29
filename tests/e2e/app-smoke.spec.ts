import { test, expect, type Page } from '@playwright/test';
import { ensureAppBuilt, launchApp } from './helpers';

// Test-only page-global flag recording whether the stage received capture-config.
declare global {
  interface Window {
    __e2eCaptureConfigSeen?: boolean;
  }
}

/**
 * App-level smoke test (issue #24): launches the REAL CandidCue Electron app
 * against the existing provider fakes and proves the layers hold together over
 * real IPC — not classes exercised in-process. The motivating failure was a
 * packaged-build mic issue no unit/integration test would have caught.
 *
 * The flow walks one interview end to end: control loads → project saved →
 * preflight usable → stage boots and receives capture events → interview begins
 * and runs to completion. All IPC is real (no mocked handlers); the only seam is
 * the env-gated provider switch (CANDIDCUE_PROVIDERS=fake).
 */
test('launches the app and runs a fake-provider interview end to end', async () => {
  await ensureAppBuilt();
  const app = await launchApp();
  try {
    const control = await app.electronApp.firstWindow();
    await control.waitForFunction(() => !!window.candidcue, undefined, { timeout: 30_000 });

    // 1. Control window loads.
    expect(await control.title()).toBeTruthy();
    expect(await control.evaluate(() => typeof window.candidcue.projects.save)).toBe('function');

    // 2. Project create + save round-trips over real IPC.
    const project = await control.evaluate(() =>
      window.candidcue.projects.save({
        title: 'E2E Smoke Project',
        targetMode: 'question_count',
        targetValue: 5,
        interviewerCharacterId: 'mira',
        documents: [
          {
            title: 'Brief',
            mimeType: 'text/markdown',
            content: 'Some preparatory notes about the topic under discussion.',
            sortOrder: 0,
          },
        ],
      }),
    );
    const projectId = project.project.id;
    expect(projectId).toBeTruthy();

    const list = await control.evaluate(() => window.candidcue.projects.list());
    expect(list.some((p) => p.id === projectId)).toBe(true);

    const got = await control.evaluate((id: string) => window.candidcue.projects.get(id), projectId);
    expect(got?.project.title).toBe('E2E Smoke Project');

    // 3. Preflight reaches a usable (canBegin) state.
    const prepared = await control.evaluate(
      (id: string) => window.candidcue.projects.prepare(id),
      projectId,
    );
    expect(prepared.ok).toBe(true);

    const preflight = await control.evaluate(
      (id: string) =>
        window.candidcue.sessions.prepare({
          projectId: id,
          config: {
            endpointMode: 'balanced',
            selectedInputDeviceId: null,
            selectedOutputDeviceId: null,
            selectedDisplayId: null,
            captionsEnabled: false,
            mirrorStage: false,
            zoom: 1,
            verticalOffsetPercent: 0,
          },
        }),
      projectId,
    );
    expect(preflight.canBegin).toBe(true);
    expect(preflight.sessionId).toBeTruthy();
    const requiredChecks = preflight.checks.filter((c) => c.required);
    expect(requiredChecks.every((c) => c.status === 'passed')).toBe(true);

    // 4. Stage window boots and receives capture events.
    let stage: Page | undefined = app.electronApp.windows().find((w) => w !== control);
    if (!stage) {
      await app.electronApp.waitForEvent('window');
      stage = app.electronApp.windows().find((w) => w !== control);
    }
    expect(stage, 'stage window should be created during preflight').toBeDefined();
    await stage!.waitForFunction(() => !!window.candidcueStage, undefined, { timeout: 20_000 });

    // Subscribe before bootstrap — the stageBootstrap handler re-sends
    // capture-config, so the listener catches it.
    await stage!.evaluate(() => {
      window.__e2eCaptureConfigSeen = false;
      window.candidcueStage.events.onCaptureConfig(() => {
        window.__e2eCaptureConfigSeen = true;
      });
    });
    const boot = await stage!.evaluate(() => window.candidcueStage.bootstrap());
    expect(boot.characterId).toBeTruthy();
    await stage!.waitForFunction(() => window.__e2eCaptureConfigSeen === true, undefined, {
      timeout: 10_000,
    });

    // 5. The interview begins and runs to completion.
    const begin = await control.evaluate(() =>
      window.candidcue.sessions.command({ type: 'BEGIN_SESSION' }),
    );
    expect(begin.ok).toBe(true);
    expect(begin.state).not.toBeNull();
    // The opening question drove the orchestrator out of READY (interview began).
    expect(begin.state).not.toBe('READY');
    expect(begin.state).not.toBe('IDLE');
    expect(begin.state).not.toBe('ERROR');

    const end = await control.evaluate(() => window.candidcue.sessions.command({ type: 'END_NOW' }));
    expect(end.ok).toBe(true);
    expect(end.state).toBe('COMPLETED');

    // The completed session is persisted and listed for the project.
    const sessions = await control.evaluate(
      (id: string) => window.candidcue.sessions.list(id),
      projectId,
    );
    expect(sessions.some((s) => s.status === 'completed')).toBe(true);
  } finally {
    await app.cleanup();
  }
});
