/**
 * The Preferences window's entry point (desktop refinement §14.1).
 *
 * A fourth webview alongside control, stage and identify. It exists because
 * §14.1 asks for Settings to stop being a page inside the document window:
 * opening it should not disturb the script you have open, closing it should not
 * navigate anywhere, and ⌘, should reach it from wherever you are.
 *
 * Deliberately minimal. It mounts the Settings surface, the toast region and the
 * confirmation host, and nothing else — no router, no library, no session. The
 * control window keeps all of that; this window has one job.
 */
import { mount } from 'svelte';
import '../styles/tokens.css';
import PreferencesApp from './PreferencesApp.svelte';
import { applyPlatformAttribute } from '../control/lib/platform';
import { followSystemAppearance } from '../control/lib/appearance';
import { bindRealVoiceFacadeIfAvailable } from '../control/services/voice-live';

/*
 * The audio services, bound here as well as in the control window.
 *
 * Settings' Audio section opens the microphone: it watches the permission,
 * enumerates inputs, and runs the level meter. All of that goes through
 * `getVoiceFacade()`, which is unbound until something calls this — and a
 * webview is its own JavaScript context, so the control window having called it
 * does nothing for this one.
 *
 * Without it the section rendered as though the microphone had never been
 * granted: no input picker, no meter, and an "Allow and choose microphone"
 * button on a machine that had already allowed it.
 */
bindRealVoiceFacadeIfAvailable();

/*
 * The workspace theme, unconditionally.
 *
 * The studio theme belongs to a running take, and a take does not happen in
 * this window. Without this the un-themed default applies — which is the DARK
 * palette, because the stage window sets no attribute (see `tokens.css`) — and
 * Settings would open black.
 */
document.documentElement.dataset['theme'] = 'workspace';
applyPlatformAttribute(document.documentElement);
followSystemAppearance(document.documentElement);

const target = document.getElementById('root');
if (!target) {
  throw new Error('Preferences window mount point #root is missing');
}

const app = mount(PreferencesApp, { target });

export default app;
