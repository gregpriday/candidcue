/**
 * The operating system's words (lib/os-copy.ts).
 *
 * Every platform here is NAMED. This project pins a Mac user agent on every
 * host (tests/setup/node-platform.ts), so a test that let the platform default
 * would only ever see the macOS column — and before the pin, would have seen
 * whichever column the machine running it happened to be.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyForErrorCode, describeError } from '../services/errors';
import { osCopy, type OsCopy } from './os-copy';
import { detectPlatform, type Platform } from './platform';
import { scriptActionLabels } from './script-action-labels';

const PLATFORMS: Platform[] = ['macos', 'windows', 'linux'];
const ROOT = join(__dirname, '..', '..', '..');

/** Every sentence a column holds, keyed by field. */
function sentences(copy: OsCopy): Array<[keyof OsCopy, string]> {
  return (Object.entries(copy) as Array<[keyof OsCopy, string | null]>).filter(
    (entry): entry is [keyof OsCopy, string] => entry[1] !== null,
  );
}

describe('the node test project', () => {
  it('runs as a Mac on every host, so the defaulted copy is the macOS column', () => {
    // Fails on a Windows or Linux machine if the setup file is ever dropped —
    // which is the whole point of having it.
    expect(detectPlatform()).toBe('macos');
    expect(osCopy()).toBe(osCopy('macos'));
  });
});

describe('osCopy', () => {
  it('keeps the macOS copy exactly as it was before the table existed', () => {
    /*
     * Byte for byte. These were literals at their call sites, asserted by unit,
     * DOM and browser tests across the suite; moving them here must not change
     * a character, and changing one later should be a decision this test makes
     * somebody take on purpose.
     */
    expect(osCopy('macos')).toEqual({
      thisDevice: 'this Mac',
      defaultInput: "your Mac's default input",
      quit: 'Quit',
      quitLower: 'quit',
      quitFailed: 'Speaking Glass didn’t quit. Choose Speaking Glass › Quit Speaking Glass, or press ⌘Q.',
      revealInFileManager: 'Reveal in Finder',
      revealScriptFailed: 'Couldn’t reveal this script in Finder.',
      windowFocusFailed:
        'That window could not be brought forward. Switch to it from the Dock or the taskbar.',
      openMicrophoneSettings: 'Open System Settings',
      openMicrophoneSettingsFailed:
        'System Settings could not be opened. Open it yourself, then go to Privacy & Security → Microphone.',
      microphoneSettingsPath: 'System Settings › Privacy & Security › Microphone',
      micFollowsSystemInput: 'Follows the input chosen in macOS.',
      micAskIntro: 'Voice following needs the microphone, and macOS will ask you once.',
      micRequestPending: 'Answer the macOS prompt to continue.',
      micRestrictedTitle: 'Microphone access is managed on this Mac',
      micRestrictedText:
        'Screen Time or a device management profile is blocking the microphone, so the setting may not be yours to change. Ask whoever manages this Mac to allow Speaking Glass.',
      micAllowedText: 'Speaking Glass is allowed in System Settings.',
      micAllowedButRefusedTitle: 'Quit and reopen Speaking Glass',
      micAllowedButRefusedText:
        'System Settings allows Speaking Glass, but macOS has not handed this window the microphone yet. It will once Speaking Glass restarts.',
      micAllowedButRefusedAnnouncement: 'Quit and reopen Speaking Glass to use the microphone.',
      micDeniedText:
        'macOS will not ask again. Turn on Speaking Glass in System Settings, then choose Try again.',
      micDeniedRetryText: 'If it is already on there, quit and reopen Speaking Glass.',
      micRecoveryNote:
        'The switch is in Privacy & Security → Microphone. If Speaking Glass is already on there, quit and reopen Speaking Glass.',
      micRefusedToast:
        'Speaking Glass is not allowed to use the microphone, so this take cannot follow your voice. Allow it in System Settings, then choose Try again in the take controls.',
      micRefusedStatusDetail: 'Allow Speaking Glass in System Settings, then choose Try again.',
      micRefusedOutcomeDetail:
        'This Mac did not allow Speaking Glass to use the microphone, so it could not follow your voice.',
      micRefusedOutcomeSuggestion:
        'Allow Speaking Glass in System Settings → Privacy & Security → Microphone before the next take.',
      micPermissionDeniedError:
        'Speaking Glass is not allowed to use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.',
      micDeniedFinding:
        'Speaking Glass is not allowed to use the microphone, so this take cannot follow your voice. Allow it in System Settings → Privacy & Security → Microphone, then try again. If it is already allowed there, quit and reopen Speaking Glass.',
      micRestrictedFinding:
        'Microphone access is restricted on this Mac, by Screen Time or a device management profile, so this take cannot follow your voice.',
      micPromptFinding:
        'Speaking Glass has not been allowed to use the microphone yet. Allow it now, so your Mac asks here rather than over the prompter.',
      micPromptAnnouncement: 'Waiting for your answer to the macOS microphone prompt.',
      micPromptWaiting: 'Waiting for macOS…',
      micPromptNote: 'Answer the macOS prompt to continue. Speaking Glass checks again as soon as you do.',
    });
  });

  it('fills every field on every platform', () => {
    for (const platform of PLATFORMS) {
      for (const [field, value] of Object.entries(osCopy(platform))) {
        if (field === 'microphoneSettingsPath' && platform === 'linux') {
          // No one place to name: the neutral column names none.
          expect(value).toBeNull();
          continue;
        }
        expect(typeof value, `${platform}.${field}`).toBe('string');
        expect((value as string).trim(), `${platform}.${field}`).not.toBe('');
      }
    }
  });

  describe('Windows', () => {
    const windows = osCopy('windows');

    it('says nothing a Mac would', () => {
      for (const [field, text] of sentences(windows)) {
        // Case matters for the capital S: Windows 11 says "Privacy & security".
        expect(text, field).not.toMatch(
          /macOS|\bMac\b|System Settings|Finder|⌘|Screen Time|Privacy & Security/,
        );
        expect(text, field).not.toMatch(/\bquit\b/i);
      }
    });

    it('promises no prompt, because WebView2 is granted without one', () => {
      for (const [field, text] of sentences(windows)) {
        expect(text, field).not.toMatch(/\bprompt\b|will ask|\banswer\b/i);
      }
    });

    it('never sends a microphone problem to a relaunch, which fixes nothing there', () => {
      for (const [field, text] of sentences(windows)) {
        if (!field.startsWith('mic')) continue;
        expect(text, field).not.toMatch(/reopen|restart|relaunch/i);
      }
    });

    it('calls the app Windows Settings, so it cannot be read as Speaking Glass’s own', () => {
      for (const [field, text] of sentences(windows)) {
        expect(text, field).not.toMatch(/(?<!Windows )\bSettings\b/);
      }
      expect(windows.openMicrophoneSettings).toBe('Open Windows Settings');
    });

    it('names the page the way Windows 11 does, and the switches by their labels', () => {
      expect(windows.microphoneSettingsPath).toBe('Windows Settings › Privacy & security › Microphone');
      expect(windows.micDeniedText).toContain('“Let apps access your microphone”');
      expect(windows.micDeniedText).toContain('“Let desktop apps access your microphone”');
    });

    it('sends a microphone Windows allows but cannot open to the device, not the switches', () => {
      expect(windows.micAllowedButRefusedText).toMatch(/Another app may be using it/);
      expect(windows.micAllowedButRefusedText).toContain('Windows Settings › System › Sound');
    });

    it('quits the way the menu and the keyboard do', () => {
      expect(windows.quit).toBe('Exit');
      expect(windows.quitFailed).toContain('File › Exit');
      expect(windows.quitFailed).toContain('Alt+F4');
    });
  });

  describe('the neutral column (Linux, and any platform not recognised)', () => {
    const linux = osCopy('linux');

    it('names no operating system and promises no prompt', () => {
      for (const [field, text] of sentences(linux)) {
        expect(text, field).not.toMatch(
          /macOS|\bMac\b|\bWindows\b|\bPC\b|System Settings|Finder|⌘|\bprompt\b|will ask/,
        );
      }
    });

    it('names no settings path, since there is no fixed one to name', () => {
      expect(linux.microphoneSettingsPath).toBeNull();
      for (const [field, text] of sentences(linux)) {
        if (!field.startsWith('mic') && field !== 'openMicrophoneSettingsFailed') continue;
        expect(text, field).not.toMatch(/[›→]/);
      }
    });
  });

  it('uses the native menu’s own words for Reveal and for Quit', () => {
    /*
     * One command, one name: `menu.rs` writes these out again in Rust, and the
     * in-window menus and the recovery screen must say what the menu bar says.
     */
    const menu = readFileSync(join(ROOT, 'src-tauri/src/menu.rs'), 'utf8');
    for (const platform of PLATFORMS) {
      expect(menu).toContain(`"${osCopy(platform).revealInFileManager}"`);
      expect(scriptActionLabels(platform).reveal).toBe(osCopy(platform).revealInFileManager);
    }
    expect(menu).toContain('PredefinedMenuItem::quit(app, Some("Quit Speaking Glass"))');
    expect(menu).toContain(`PredefinedMenuItem::quit(app, Some("${osCopy('windows').quit}"))`);
    // GTK has no predefined Quit, so Linux's File › Exit is an item of its own.
    expect(menu).toContain(`MenuItem::with_id(app, LINUX_EXIT_ID, "${osCopy('linux').quit}"`);
    expect(osCopy('linux').quit).toBe(osCopy('windows').quit);
  });
});

describe('error copy that names the operating system', () => {
  /*
   * ERROR_COPY is a module constant, and an entry that captured the platform
   * when errors.ts was first imported would say whatever that moment's user
   * agent said for the life of the process. The OS-worded entries are read
   * when asked for, which this proves by changing the platform in between.
   */
  function asPlatform(platform: string, run: () => void): void {
    const pinned = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
    try {
      run();
    } finally {
      if (pinned) Object.defineProperty(navigator, 'platform', pinned);
    }
  }

  it('follows the platform it is read on', () => {
    asPlatform('Win32', () => {
      expect(copyForErrorCode('MIC_PERMISSION_DENIED')).toBe(osCopy('windows').micPermissionDeniedError);
      expect(describeError(new Error('MIC_PERMISSION_DENIED'))).toBe(
        osCopy('windows').micPermissionDeniedError,
      );
      expect(copyForErrorCode('WINDOW_CLOSE_FAILED')).toBe(
        'The window could not be closed. Exit Speaking Glass instead.',
      );
      expect(copyForErrorCode('WINDOW_FOCUS_FAILED')).toBe(osCopy('windows').windowFocusFailed);
    });
    expect(copyForErrorCode('MIC_PERMISSION_DENIED')).toBe(osCopy('macos').micPermissionDeniedError);
    expect(copyForErrorCode('WINDOW_CLOSE_FAILED')).toBe(
      'The window could not be closed. Quit Speaking Glass instead.',
    );
  });
});
