/**
 * The operating system's own words, for every sentence that names it.
 *
 * ---------------------------------------------------------------------------
 * ONE TABLE, ONE COLUMN PER PLATFORM
 * ---------------------------------------------------------------------------
 * The copy was written on a Mac, for a Mac, and a Windows user was told to open
 * System Settings, to answer a prompt that never appears, and to press ⌘Q. The
 * fix is not a `detectPlatform()` at each of those sentences — that is exactly
 * the scattering `platform.ts` forbids — but this one table, which the call
 * sites read. TypeScript makes every column complete: a sentence added for one
 * platform does not compile until the other two have it.
 *
 * A sentence whose SHAPE differs between platforms is written out whole in
 * each column, not assembled from swapped nouns. "macOS will not ask again"
 * has no Windows counterpart with a different subject — Windows never asked —
 * so its column says something else entirely.
 *
 * The macOS column is the copy as it was before this table existed, byte for
 * byte. The node test project pins a Mac user agent (`tests/setup/
 * pin-mac-platform.ts`) so every assertion of it holds on any host, and the
 * Windows and Linux columns are tested by passing a platform explicitly.
 *
 * ---------------------------------------------------------------------------
 * WINDOWS: WHAT THE OS ACTUALLY DOES
 * ---------------------------------------------------------------------------
 *   - The app grants its own WebView2 pages the microphone, so there is NO
 *     prompt. The only gate is Settings › Privacy & security › Microphone:
 *     `denied` is "Let apps access your microphone" or "Let desktop apps
 *     access your microphone" switched off (the user's to change); `restricted`
 *     is the device-wide "Microphone access" switch, or a policy, which needs
 *     an administrator.
 *   - There is no TCC-style cache to clear by relaunching. A microphone Windows
 *     allows that still will not open is in use or unplugged, and the honest
 *     advice is to look at it, not to reopen CandidCue.
 *   - The app is called Settings, and this column says WINDOWS Settings,
 *     because CandidCue has a Settings window of its own and "Open Settings"
 *     beside it would read as that.
 *   - "this PC" is Windows' own name for the machine (File Explorer's This PC,
 *     Settings' Rename this PC).
 *   - The verb for ending the application is the menu's: `menu.rs` puts Exit
 *     at the foot of File on Windows and Linux, so the copy says Exit too.
 *
 * ---------------------------------------------------------------------------
 * LINUX: THE NEUTRAL COLUMN
 * ---------------------------------------------------------------------------
 * `detectPlatform()` falls back to `linux` for anything it cannot identify —
 * jsdom included — so this column must never promise a prompt, a pane or a
 * path that may not exist. It says "your system settings" and "this
 * computer". The file-manager name is the exception: it matches the native
 * menu, which says "Show in File Explorer" everywhere but macOS, because one
 * command must have one name.
 */
import { detectPlatform, type Platform } from './platform';

export interface OsCopy {
  /* -- the machine and the application ----------------------------------- */
  /** The computer, mid-sentence: "Speech is transcribed on this Mac". */
  thisDevice: string;
  /** The input a take falls back to when no microphone is pinned or connected. */
  defaultInput: string;
  /** Ending the application, at the start of a sentence: "Quit and reopen…". */
  quit: string;
  /** The same verb mid-sentence: "…when you quit and reopen CandidCue." */
  quitLower: string;
  /** Recovery: the window would not close, so say the platform's other way out. */
  quitFailed: string;
  /** The native menu's name for showing a script's folder (`menu.rs::reveal_label`). */
  revealInFileManager: string;
  /** That reveal failed. */
  revealScriptFailed: string;
  /** WINDOW_FOCUS_FAILED: where the user can switch to the window themselves. */
  windowFocusFailed: string;

  /* -- the OS microphone settings ---------------------------------------- */
  /** The button that opens the OS microphone privacy page. */
  openMicrophoneSettings: string;
  /** That page did not open; the error's own description is appended. */
  openMicrophoneSettingsFailed: string;
  /** Where the switch is, as its own line. Null where there is no fixed place to name. */
  microphoneSettingsPath: string | null;

  /* -- Settings › Audio › Microphone ------------------------------------- */
  /** The input picker's description when it follows the system default. */
  micFollowsSystemInput: string;
  /** Before the first request: why the microphone is wanted. */
  micAskIntro: string;
  /** A request is in flight. Shown in the card and announced. */
  micRequestPending: string;
  /** `restricted`, as the card's title (the announcement adds a full stop). */
  micRestrictedTitle: string;
  micRestrictedText: string;
  /** The OS allows the microphone and the webview has not opened it yet. */
  micAllowedText: string;
  /** The OS allows it, yet "Try again" was refused again. */
  micAllowedButRefusedTitle: string;
  micAllowedButRefusedText: string;
  micAllowedButRefusedAnnouncement: string;
  /** `denied`: how to turn it back on. */
  micDeniedText: string;
  /** Added once "Try again" has been refused again. */
  micDeniedRetryText: string;

  /* -- the take ---------------------------------------------------------- */
  /** Live's note under "Microphone not allowed", beside the way back. */
  micRecoveryNote: string;
  /** The take's notice for a refused microphone. */
  micRefusedToast: string;
  /** The take controls' status detail, after what the text is doing. */
  micRefusedStatusDetail: string;
  /** The take summary when the microphone was refused. */
  micRefusedOutcomeDetail: string;
  micRefusedOutcomeSuggestion: string;
  /** MIC_PERMISSION_DENIED, wherever `describeError` meets it. */
  micPermissionDeniedError: string;

  /* -- the readiness sheet before a take --------------------------------- */
  micDeniedFinding: string;
  micRestrictedFinding: string;
  micPromptFinding: string;
  /** "Allow microphone" pressed: announced, on the button, and under it. */
  micPromptAnnouncement: string;
  micPromptWaiting: string;
  micPromptNote: string;
}

const MACOS: OsCopy = {
  thisDevice: 'this Mac',
  defaultInput: "your Mac's default input",
  quit: 'Quit',
  quitLower: 'quit',
  quitFailed: 'CandidCue didn’t quit. Choose CandidCue › Quit CandidCue, or press ⌘Q.',
  revealInFileManager: 'Reveal in Finder',
  revealScriptFailed: 'Couldn’t reveal this script in Finder.',
  windowFocusFailed: 'That window could not be brought forward. Switch to it from the Dock or the taskbar.',

  openMicrophoneSettings: 'Open System Settings',
  openMicrophoneSettingsFailed:
    'System Settings could not be opened. Open it yourself, then go to Privacy & Security → Microphone.',
  microphoneSettingsPath: 'System Settings › Privacy & Security › Microphone',

  micFollowsSystemInput: 'Follows the input chosen in macOS.',
  micAskIntro: 'Voice following needs the microphone, and macOS will ask you once.',
  micRequestPending: 'Answer the macOS prompt to continue.',
  micRestrictedTitle: 'Microphone access is managed on this Mac',
  micRestrictedText:
    'Screen Time or a device management profile is blocking the microphone, so the setting may not be yours to change. Ask whoever manages this Mac to allow CandidCue.',
  micAllowedText: 'CandidCue is allowed in System Settings.',
  micAllowedButRefusedTitle: 'Quit and reopen CandidCue',
  micAllowedButRefusedText:
    'System Settings allows CandidCue, but macOS has not handed this window the microphone yet. It will once CandidCue restarts.',
  micAllowedButRefusedAnnouncement: 'Quit and reopen CandidCue to use the microphone.',
  micDeniedText: 'macOS will not ask again. Turn on CandidCue in System Settings, then choose Try again.',
  micDeniedRetryText: 'If it is already on there, quit and reopen CandidCue.',

  micRecoveryNote:
    'The switch is in Privacy & Security → Microphone. If CandidCue is already on there, quit and reopen CandidCue.',
  micRefusedToast:
    'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. ' +
    'Allow it in System Settings, then choose Try again in the take controls.',
  micRefusedStatusDetail: 'Allow CandidCue in System Settings, then choose Try again.',
  micRefusedOutcomeDetail: 'This Mac did not allow CandidCue to use the microphone, so it could not follow your voice.',
  micRefusedOutcomeSuggestion:
    'Allow CandidCue in System Settings → Privacy & Security → Microphone before the next take.',
  micPermissionDeniedError:
    'CandidCue is not allowed to use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.',

  micDeniedFinding:
    'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. Allow it in System Settings → Privacy & Security → Microphone, then try again. If it is already allowed there, quit and reopen CandidCue.',
  micRestrictedFinding:
    'Microphone access is restricted on this Mac, by Screen Time or a device management profile, so this take cannot follow your voice.',
  micPromptFinding:
    'CandidCue has not been allowed to use the microphone yet. Allow it now, so your Mac asks here rather than over the prompter.',
  micPromptAnnouncement: 'Waiting for your answer to the macOS microphone prompt.',
  micPromptWaiting: 'Waiting for macOS…',
  micPromptNote: 'Answer the macOS prompt to continue. CandidCue checks again as soon as you do.',
};

/*
 * Neither column below promises a prompt. Windows has none; on anything else
 * there may or may not be one, so the prompt-path sentences (which Windows
 * never reaches — its permission read never answers `prompt`) speak of "any
 * question" rather than of an answer the user is waiting to give.
 */
const PROMPT_FINDING_WITHOUT_A_PROMPT =
  'CandidCue has not been allowed to use the microphone yet. Allow it now, so any question about it comes here rather than over the prompter.';

const WINDOWS: OsCopy = {
  thisDevice: 'this PC',
  defaultInput: "your PC's default input",
  quit: 'Exit',
  quitLower: 'exit',
  quitFailed: 'CandidCue didn’t close. Choose File › Exit, or press Alt+F4.',
  revealInFileManager: 'Show in File Explorer',
  revealScriptFailed: 'Couldn’t show this script in File Explorer.',
  windowFocusFailed: 'That window could not be brought forward. Switch to it from the taskbar.',

  openMicrophoneSettings: 'Open Windows Settings',
  openMicrophoneSettingsFailed:
    'Windows Settings could not be opened. Open it yourself, then go to Privacy & security → Microphone.',
  microphoneSettingsPath: 'Windows Settings › Privacy & security › Microphone',

  micFollowsSystemInput: 'Follows the input chosen in Windows.',
  micAskIntro: 'Voice following needs the microphone.',
  micRequestPending: 'Opening the microphone.',
  micRestrictedTitle: 'Microphone access is off for this whole PC',
  micRestrictedText:
    'The device-wide Microphone access switch is off, or a policy turns it off, so the setting may not be yours to change. Ask whoever manages this PC to turn it on.',
  micAllowedText: 'Windows allows desktop apps to use the microphone.',
  micAllowedButRefusedTitle: 'The microphone could not be opened',
  micAllowedButRefusedText:
    'Windows allows desktop apps to use the microphone, but it did not open. Another app may be using it, or it may be unplugged. Check it in Windows Settings › System › Sound, then try again.',
  micAllowedButRefusedAnnouncement:
    'The microphone could not be opened. Check it in Windows Settings › System › Sound, then try again.',
  micDeniedText:
    'Windows is blocking the microphone. In Windows Settings, turn on “Let apps access your microphone” and “Let desktop apps access your microphone”, then choose Try again.',
  micDeniedRetryText:
    'If both are already on, another app may be using the microphone, or it may be unplugged. Check it in Windows Settings › System › Sound.',

  micRecoveryNote:
    'The switches are in Privacy & security → Microphone. If both are already on, check the microphone in System → Sound.',
  micRefusedToast:
    'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. ' +
    'Allow apps to use the microphone in Windows Settings, then choose Try again in the take controls.',
  micRefusedStatusDetail: 'Allow apps to use the microphone in Windows Settings, then choose Try again.',
  micRefusedOutcomeDetail:
    'Windows did not allow CandidCue to use the microphone, so it could not follow your voice.',
  micRefusedOutcomeSuggestion:
    'Allow apps to use the microphone in Windows Settings → Privacy & security → Microphone before the next take.',
  micPermissionDeniedError:
    'CandidCue is not allowed to use the microphone. Allow apps to use it in Windows Settings → Privacy & security → Microphone, then try again.',

  micDeniedFinding:
    'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. In Windows Settings → Privacy & security → Microphone, turn on “Let apps access your microphone” and “Let desktop apps access your microphone”, then try again.',
  micRestrictedFinding:
    'Microphone access is off for this whole PC, by its device-wide switch or a policy, so this take cannot follow your voice.',
  micPromptFinding: PROMPT_FINDING_WITHOUT_A_PROMPT,
  micPromptAnnouncement: 'Opening the microphone.',
  micPromptWaiting: 'Opening the microphone…',
  micPromptNote: 'CandidCue checks again as soon as it opens.',
};

const LINUX: OsCopy = {
  thisDevice: 'this computer',
  defaultInput: "your computer's default input",
  quit: 'Exit',
  quitLower: 'exit',
  quitFailed: 'CandidCue didn’t close. Choose File › Exit, or close its window.',
  revealInFileManager: 'Show in File Explorer',
  revealScriptFailed: 'Couldn’t show this script in File Explorer.',
  windowFocusFailed: 'That window could not be brought forward. Switch to it from the Dock or the taskbar.',

  openMicrophoneSettings: 'Open system settings',
  openMicrophoneSettingsFailed:
    'Your system settings could not be opened. Open them yourself and allow CandidCue to use the microphone.',
  microphoneSettingsPath: null,

  micFollowsSystemInput: 'Follows the input chosen in your system settings.',
  micAskIntro: 'Voice following needs the microphone.',
  micRequestPending: 'If your system asks, allow CandidCue to use the microphone.',
  micRestrictedTitle: 'Microphone access is managed on this computer',
  micRestrictedText:
    'A system policy is blocking the microphone, so the setting may not be yours to change. Ask whoever manages this computer to allow CandidCue.',
  micAllowedText: 'Your system allows CandidCue to use the microphone.',
  micAllowedButRefusedTitle: 'The microphone could not be opened',
  micAllowedButRefusedText:
    'Your system allows CandidCue to use the microphone, but it did not open. Another app may be using it, or it may be unplugged. Check your sound settings, then try again.',
  micAllowedButRefusedAnnouncement: 'The microphone could not be opened. Check your sound settings, then try again.',
  micDeniedText:
    'CandidCue is not allowed to use the microphone. Allow it in your system settings, then choose Try again.',
  micDeniedRetryText:
    'If it is already allowed, another app may be using the microphone, or it may be unplugged.',

  micRecoveryNote:
    'If CandidCue is already allowed, check that the microphone is connected and not in use by another app.',
  micRefusedToast:
    'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. ' +
    'Allow it in your system settings, then choose Try again in the take controls.',
  micRefusedStatusDetail: 'Allow CandidCue in your system settings, then choose Try again.',
  micRefusedOutcomeDetail:
    'This computer did not allow CandidCue to use the microphone, so it could not follow your voice.',
  micRefusedOutcomeSuggestion:
    'Allow CandidCue to use the microphone in your system settings before the next take.',
  micPermissionDeniedError:
    'CandidCue is not allowed to use the microphone. Allow it in your system settings, then try again.',

  micDeniedFinding:
    'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. Allow it in your system settings, then try again.',
  micRestrictedFinding:
    'Microphone access is restricted on this computer by a system policy, so this take cannot follow your voice.',
  micPromptFinding: PROMPT_FINDING_WITHOUT_A_PROMPT,
  micPromptAnnouncement: 'Waiting for the microphone.',
  micPromptWaiting: 'Waiting…',
  micPromptNote: 'If your system asks, allow the microphone. CandidCue checks again as soon as it can.',
};

const OS_COPY: Record<Platform, OsCopy> = { macos: MACOS, windows: WINDOWS, linux: LINUX };

/**
 * The words for `platform` — this window's own, unless a caller (a test, or a
 * pure function that takes the platform as an argument) names one.
 *
 * Read at the point of use rather than captured at import, so a module that
 * builds copy does not freeze whichever user agent happened to be present when
 * it was first loaded.
 */
export function osCopy(platform: Platform = detectPlatform()): OsCopy {
  return OS_COPY[platform];
}
