# CandidCue
## Product, UX, Architecture, and Implementation Specification

**Document status:** Build-ready product and technical specification  
**Research cut-off for this document:** 24 July 2026  
**Target release:** Desktop v1.0  
**Primary platforms:** macOS and Windows  
**Architecture:** Tauri 2, Svelte + TypeScript frontend, Rust core  
**Speech platform:** OpenAI Realtime transcription, bring your own API key  
**Command model:** `gpt-5.6-luna`  
**Product domain:** `CandidCue.com`

---

## 0. How to use this document

This document is the source of truth for the first production implementation of CandidCue. It defines:

- the product boundary and differentiation;
- every primary user flow and screen;
- the visual and interaction model;
- the Markdown document contract;
- the real-time transcription, script-alignment, retake, and voice-command systems;
- the Tauri/Rust/Svelte architecture;
- persistence, security, privacy, packaging, and update behavior;
- implementation order, test strategy, acceptance criteria, and release gates.

Where the existing Electron prototype conflicts with this specification, use the Electron project only as **visual and interaction reference**. Do not migrate its runtime architecture, Electron APIs, preload bridge, dependency tree, storage implementation, or process model. Rebuild the application cleanly in Tauri.

The implementation should optimize for a small, calm, polished desktop product rather than for maximum feature count. A feature is not complete because a control exists; it is complete only when its full happy path, empty state, permission state, loading state, failure state, and recovery path are implemented.

### 0.1 Document map

- **Part I — Product definition (Sections 1–8):** promise, scope, users, competition, terminology, and fixed decisions.
- **Part II — User experience and visual specification (Sections 9–20):** complete journeys, information architecture, design system, library, editor, preflight, live controls, stage, calibration, settings, shortcuts, and accessibility.
- **Part III — Script documents and preparation (Sections 21–26):** Markdown lifecycle, directives, images/diagrams/tables, compiler IR, and script vocabulary.
- **Part IV — Voice tracking and hands-free control (Sections 27–36):** OpenAI integration, microphone and session handling, transcript reconciliation, alignment, stage motion, commands, cost, and session records.
- **Part V — Listener mode (Sections 37–41):** product behavior, media production, signed asset packs, playback, and lens calibration.
- **Part VI — Application architecture (Sections 42–53):** stack, windows, Rust and frontend modules, IPC, persistence, recovery, Tauri security, privacy, performance, platform behavior, packaging, and updates.
- **Part VII — Implementation and validation (Sections 54–61):** risk spikes, build phases, tests, speech corpus, acceptance criteria, QA, Electron design migration, roadmap boundaries, and release definition.
- **Appendices A–I:** defaults, database schema, TypeScript contracts, Tauri configuration, OpenAI flows, UI copy, pseudocode, research sources, and implementation-agent instructions.

---

# Part I — Product definition

## 1. Executive summary

CandidCue is a lightweight desktop teleprompter that follows the speaker’s voice instead of scrolling at a fixed speed. The user writes or imports a Markdown script, opens it on a dedicated second display or teleprompter monitor, and speaks naturally. CandidCue transcribes the microphone in real time, aligns the transcript against the entire script, and keeps the current passage in a stable reading zone.

The app must handle normal speaking behavior rather than expecting a perfect linear read. It should:

- pause when the user ad-libs;
- reacquire when the user returns to the script;
- follow intentional skips;
- recognize a repeated sentence or paragraph as a retake;
- move backward only when the evidence is strong enough to avoid false jumps;
- accept deliberate spoken commands after a wake phrase, such as “CandidCue, go to chapter one” or “CandidCue, restart this section.”

CandidCue also offers a distinctive **Listener** mode. A dim, silent, subtly animated person appears behind or beside the script so that the user feels as though they are talking to a client, customer, interviewer, or audience member rather than reading into an empty lens. Listener videos are downloaded as optional asset packs and remain local after download. They never speak or react to the user.

The application is local-first and account-free. Scripts, preferences, listener media, and document assets remain on the user’s device. The user supplies an OpenAI API key. While voice tracking is active, microphone audio is sent to OpenAI’s Realtime transcription API. Optional script vocabulary analysis and ambiguous command interpretation use GPT-5.6 Luna through the same key.

### 1.1 The essential product promise

> Put the script on the screen, look into the lens, and speak naturally. CandidCue keeps your place.

### 1.2 What makes the product worth building

Voice-following teleprompters already exist. CandidCue is not differentiated by automatic scrolling alone. Its differentiated bundle is:

1. **A focused desktop application built for a real second display**, including compact teleprompter hardware such as Elgato Prompter.
2. **Whole-script alignment**, including retakes, skips, and backtracking, rather than a naïve “match the next few words” implementation.
3. **A Markdown-first script system** capable of rendered headings, cues, images, tables, and diagrams.
4. **Voice control with a wake phrase**, allowing hands-free navigation and visual adjustments.
5. **Silent Listener personas**, positioned around the lens and dimmed behind the script.
6. **A small, polished, local-first desktop footprint**, without accounts, collaboration, recording, or a broad creator suite.

### 1.3 The hardest technical problem

The central difficulty is not transcription. It is robustly estimating the speaker’s position in a known script while the transcript is partial, imperfect, delayed, and occasionally wrong. The script-alignment engine is therefore a first-class product subsystem, with its own corpus, metrics, state machine, and release gates.

---

## 2. Product goals

### 2.1 Primary goals

1. A new user can install the app, add an API key, grant microphone permission, paste a script, test transcription, choose a display, and begin prompting without reading documentation.
2. The live stage remains visually calm and readable while the tracking engine continuously updates its confidence and position.
3. Voice tracking works with natural deviations: pauses, filler words, ad-libs, repeated phrases, skips, and retakes.
4. A user can control the session without touching the keyboard by saying the wake phrase followed by a supported command.
5. The app remains useful when OpenAI is unavailable: scripts can still be edited and the teleprompter can run in manual or fixed-speed mode.
6. The permanent OpenAI key never enters browser storage, application logs, the stage window, or persistent frontend state.
7. CandidCue feels like a purpose-built native desktop product rather than a web page placed inside a window.

### 2.2 Secondary goals

- Make teleprompter hardware setup unusually easy through display identification, remembered display profiles, mirroring, and lens calibration.
- Give users a psychologically easier delivery experience through Listener mode.
- Keep the installed application small by downloading Listener packs on demand.
- Make script data easy to recover and export by retaining canonical Markdown files in addition to the database index.
- Establish an evaluation harness that makes later tracking improvements measurable rather than subjective.

### 2.3 Business-aligned goals

- Support a low-priced, one-time-purchase desktop product without requiring CandidCue-hosted inference.
- Avoid recurring infrastructure costs for the developer beyond static asset delivery and software updates.
- Keep support burden low through excellent preflight diagnostics and explicit error messages.
- Build an architecture that can later support a web version, local speech recognition, remote control, or cloud sync without forcing those systems into v1.

---

## 3. Explicit non-goals for v1

CandidCue v1 is **not**:

- a camera or screen recorder;
- a video editor;
- a subtitle editor or caption-export system;
- an AI interviewer or conversational avatar;
- a script-writing assistant;
- a cloud document collaboration product;
- a mobile teleprompter;
- a browser application;
- a remote-production control room;
- a team account system;
- a general-purpose Markdown knowledge base;
- an always-listening background assistant;
- an offline speech-recognition product;
- a replacement for OBS, Camera Hub, Zoom, or presentation software.

The following are also outside the initial release unless they become necessary for launch quality:

- cloud sync;
- accounts and profiles;
- camera preview;
- Stream Deck integration;
- MIDI, game-controller, foot-pedal, or phone remote support;
- automatic script generation or rewriting;
- teleprompter recording analytics;
- collaborative comments and approvals;
- Linux as a fully supported commercial platform.

---

## 4. Product principles

### 4.1 Follow; do not chase

The stage should appear to understand the speaker, but it must not twitch after every uncertain word. Stable, slightly conservative movement is better than aggressive movement followed by correction.

### 4.2 Freeze rather than guess

When confidence falls, hold the current reading position and wait for stronger evidence. A teleprompter that stops briefly is usable. A teleprompter that jumps to the wrong paragraph destroys the take.

### 4.3 Every automatic action must have a manual escape hatch

Voice following, voice commands, Listener playback, display selection, and full-screen behavior all require obvious manual controls. The user must never be trapped by the “smart” behavior.

### 4.4 The stage is sacred

No modal dialogs, API errors, permission prompts, update banners, download progress, or developer diagnostics may unexpectedly appear on the stage display. All operational UI belongs in the control window. The stage may show only intentionally selected reading aids and brief, unobtrusive command acknowledgements.

### 4.5 Local-first must be described honestly

Scripts and settings are local, but voice tracking is not offline. The UI must clearly state what is sent to OpenAI and when. Do not use “fully private” or “everything stays on your device” language.

### 4.6 No hidden readiness

A green “Ready” state means the complete chain has been tested: the selected microphone produced audio, OpenAI accepted a transcription session, transcript events arrived, the script compiled, and the chosen stage display opened successfully.

### 4.7 Narrow scope, deep finish

Do not add a broad feature because competitors have it. Finish the narrow workflow: write, prepare, calibrate, present, retake, stop.

---

## 5. Target users and jobs to be done

### 5.1 Primary user: solo presenter or creator

The user records product videos, sales videos, tutorials, updates, course material, or founder-led content. They operate their own camera and computer and do not have a producer scrolling the script.

**Job:** “Help me deliver a prepared script naturally without memorizing it or touching controls during a take.”

### 5.2 Secondary user: remote professional

The user presents to a webcam, records asynchronous client messages, or gives structured demos. They may use a compact lens-mounted display.

**Job:** “Help me maintain eye contact while staying accurate and sounding conversational.”

### 5.3 Secondary user: narrator or educator

The user reads longer material, needs chapter navigation, and frequently restarts sentences or sections.

**Job:** “Keep up with my place over a long script, including when I repeat a passage.”

### 5.4 Anti-personas

CandidCue is not optimized for:

- broadcast studios that require operator consoles, timecode, rundown integration, or SDI;
- teams that need shared cloud scripts and approval workflows;
- mobile-only creators recording directly on a phone;
- users who require guaranteed offline speech recognition;
- live events where an internet interruption is unacceptable and no manual operator is available.

---

## 6. Competitive grounding and product position

Voice-following is a validated category rather than a novel invention. Current products demonstrate the expected baseline:

| Product | Relevant strength | Implication for CandidCue |
|---|---|---|
| VoicePrompter | Matches against the whole script; follows ad-libs, skips, and backtracking; supports non-spoken bracket cues; emphasizes local/offline processing | Whole-script reacquisition and backward retakes are baseline-quality expectations, not optional polish |
| PromptSmart | VoiceTrack scrolls while speaking, stops on pauses or improvisation, and resumes on script; includes waypoints and remote workflows | CandidCue must pause cleanly during off-script speech and resume without user intervention |
| Elgato Camera Hub / Voice Sync | Strong integration with a dedicated second-display teleprompter; voice-based pacing; hardware-specific workflow | Display selection, mirroring, compact layouts, and reliable full-screen placement are central product features |
| Speakflow | Browser-based voice following, collaboration, remote synchronization, and recording | CandidCue should intentionally remain narrower and more local rather than imitate a team suite |
| Teleprompter.com | Broad cross-platform product with voice scrolling, fixed modes, recording, remotes, mirroring, and cloud sync | Manual/fixed-speed fallback and mirroring are expected, but recording and cloud breadth are outside scope |

### 6.1 Closest direct benchmark

VoicePrompter is the closest conceptual benchmark for the tracking engine. It explicitly markets whole-script matching, ad-lib tolerance, skipping, backward scrolling, and exact-position tapping. CandidCue must meet the same behavioral expectation even though its speech source is cloud-based.

### 6.2 CandidCue’s intended position

CandidCue should be positioned as:

> A small, beautifully finished desktop teleprompter for people who work alone: Markdown scripts, intelligent voice following, hands-free commands, and someone to look at while you speak.

### 6.3 Candid weaknesses that product copy must not conceal

- OpenAI Realtime transcription currently costs **$0.017 per minute**, approximately **$1.02 per active hour**, paid by the user through their API key.
- Voice tracking requires an internet connection.
- Audio is transmitted to OpenAI while tracking is active.
- A local/offline competitor can have lower marginal cost and stronger privacy claims.

The product must compensate with better transcription quality across microphones and accents, excellent setup diagnostics, stronger commands, richer Markdown presentation, and the Listener experience.

---

## 7. Core product terminology

Use these terms consistently in UI, code, documentation, and analytics:

- **Control window:** The main application window used to manage scripts, settings, preflight, and live controls.
- **Stage window:** The clean output window shown on the teleprompter or second display.
- **Script:** The canonical Markdown document plus its local assets and settings.
- **Compiled script:** The sanitized rendered document, block model, outline, spoken-token index, and cue metadata produced from the Markdown source.
- **Session:** One period in which a script is opened for prompting.
- **Voice tracking:** Realtime transcription plus script alignment and automatic stage positioning.
- **Manual mode:** The user controls position directly; no transcription is required.
- **Fixed-speed mode:** The stage scrolls at a selected speed.
- **Listener:** A silent looping human video used as a background or conversational focal point.
- **Wake phrase:** The spoken prefix that gates voice commands. Default: “CandidCue.”
- **Script vocabulary:** Automatically and manually identified unusual terms and spoken variants used by the local matcher.
- **Reading band:** The stable vertical area in which the current spoken text is held.
- **Tracking cursor:** The engine’s best estimate of the current script token.
- **Take marker:** A user-created return point used by “retake” or explicit navigation.

---

## 8. Non-negotiable implementation decisions

These decisions are fixed for v1 unless a technical spike proves one impossible:

1. Build a new Tauri 2 project rather than converting the Electron application in place.
2. Use a **two-window architecture**: a capable control window and a minimally privileged stage window.
3. Use Svelte with TypeScript and Vite as a client-side application; do not add a server-side web framework to the desktop runtime.
4. Accept the API key through a one-shot masked control-window field, transfer it immediately to Rust, and store the saved key in the operating system’s secure credential store. After that initial entry, the stored key remains inside the Rust trust boundary.
5. Use OpenAI Realtime transcription with `gpt-realtime-whisper` as the default live model.
6. Use a short-lived OpenAI client secret for the webview’s WebRTC connection; never return the stored permanent key to JavaScript after its one-time user entry.
7. Put tracking logic behind a deterministic local alignment engine. Do not ask an LLM to continuously decide the user’s script position.
8. Parse exact/common voice commands locally. Use GPT-5.6 Luna only for ambiguous natural-language commands.
9. Use strict schemas and an allow-listed command validator before executing any Luna interpretation.
10. Store scripts as canonical Markdown files with SQLite metadata and indexes.
11. Disable raw HTML in scripts. Sanitize all rendered output.
12. Download Listener packs on demand and verify their manifest, size, and cryptographic checksum before use.
13. Bundle no remote JavaScript, CSS, fonts, or executable content.
14. Ship macOS and Windows as supported v1 platforms. Treat Linux as a later compatibility project.
15. Keep editor, manual prompting, and fixed-speed prompting functional without an API key or network connection.

---

# Part II — User experience and visual specification

## 9. End-to-end user journeys

### 9.1 First launch

1. The app opens to a restrained welcome screen, not directly into an empty editor.
2. The welcome screen contains:
   - CandidCue wordmark and one-sentence product explanation;
   - **Create your first script** as the primary action;
   - **Import Markdown** as a secondary action;
   - a short three-item readiness list: OpenAI key, microphone, display;
   - a link to privacy details.
3. Creating a script opens the editor with a short example document that demonstrates a heading, a paragraph, and a cue. The example is selected so the user can immediately replace it.
4. The first attempt to open the prompter launches Preflight.
5. Preflight requests the API key first, then asks for microphone access only after a direct user action such as **Allow and test microphone**. Never trigger an operating-system permission dialog on app launch.
6. The user chooses the output display and presses **Show display test**. The selected stage shows a large number and the words “CandidCue stage.”
7. The user speaks a test phrase. The actual transcript appears in the control window.
8. When all required checks pass, the user presses **Start session**.
9. The stage opens in full screen and waits at the beginning. The user can click Start or say “CandidCue, start.”

### 9.2 Returning user with a prepared script

1. App opens to the script library with the most recent script selected.
2. The user double-clicks the script or presses **Open**.
3. The editor restores its last mode and cursor position.
4. **Present** opens a compact Preflight sheet using the previously selected microphone, display profile, tracking mode, and Listener.
5. The app revalidates the microphone and OpenAI connection. It does not force a full spoken test every time unless the device changed or the previous test is stale.
6. The user starts the session.

### 9.3 Retake during a session

Natural retake:

1. The user stops, then repeats the start of the current or previous sentence.
2. The aligner detects a strong earlier sequence within the current section.
3. The tracking cursor moves backward only after the backward-jump threshold is satisfied.
4. The stage returns smoothly for a short retake or uses a brief fade-and-snap for a large jump.
5. No visible “retake mode” is required.

Explicit retake:

1. The user says “CandidCue, restart this paragraph,” “CandidCue, restart this section,” or “CandidCue, retake.”
2. `retake` returns to the most recent take marker. If no take marker exists, it returns to the beginning of the current paragraph.
3. The command phrase is excluded from script alignment.
4. The stage briefly acknowledges the destination, then resumes listening.

### 9.4 Jumping to a chapter

1. The user says “CandidCue, go to chapter one” or “CandidCue, go to pricing.”
2. The local command parser resolves numeric chapter references and exact/fuzzy heading names.
3. If the target is ambiguous, Luna receives only the command, current location, and compact script outline.
4. The app validates the target and performs the jump.
5. Tracking enters a short post-jump lock, preventing stale transcript events from pulling the cursor back.

### 9.5 Network loss

1. The OpenAI connection drops.
2. The stage freezes at the current location; it does not close or display an error.
3. The control window changes the status to **Reconnecting** and shows manual controls.
4. Automatic retries use bounded exponential backoff.
5. The user may switch to manual or fixed-speed mode immediately.
6. On reconnection, the app resumes from the current tracking cursor and requires new matching speech to reacquire. It does not replay stale transcript data.

### 9.6 Microphone disconnection

1. The capture track ends or the selected device disappears.
2. The stage freezes.
3. The control window shows **Microphone disconnected** and offers available devices.
4. If the system default changes to a valid input, the user may enable **Follow system default** to reconnect automatically.
5. Reconnection requires an explicit successful level check before status returns to Ready.

### 9.7 Second display disconnection

1. The monitor topology changes and the selected stage monitor disappears.
2. The app immediately blanks and closes or hides the orphaned stage surface; it must not move private script content to the primary recording/control display automatically.
3. Tracking soft-pauses by default, while the script cursor and Listener playback state are preserved. An advanced setting may allow control-side tracking to continue without a visible stage.
4. The control window displays **Stage display disconnected** and lists currently available displays.
5. The user reconnects the intended monitor or selects another display, then presses **Restore stage**. The stage reopens at the preserved cursor only after the selected target is confirmed.

---

## 10. Information architecture

The control window has five top-level destinations:

1. **Scripts** — library, search, folders/tags if later enabled.
2. **Editor** — Markdown source, rendered preview, outline, script vocabulary.
3. **Preflight** — display, microphone, OpenAI, tracking, appearance, Listener.
4. **Live** — session status and controls while the stage is active.
5. **Settings** — application-wide defaults, API key, privacy, storage, updates.

Do not present all five as equal permanent tabs. The primary navigation is:

- a left library sidebar while browsing/editing;
- contextual transitions from Editor → Preflight → Live;
- Settings accessed from the sidebar footer or application menu.

### 10.1 Window model

**Control window**

- Default minimum size: 980 × 680 logical pixels.
- Recommended default: 1240 × 820.
- Resizable.
- Restores size and position.
- Uses native application menu conventions on macOS and Windows.

**Stage window**

- Created hidden and undecorated.
- Resizable only in windowed preview mode.
- Full-screen or borderless to the bounds of the selected monitor during a session.
- Never receives the permanent API key, direct database access, arbitrary filesystem access, or settings write capability.
- Can be closed independently without terminating the control window.

---

## 11. Visual identity and design system

The existing Electron project should be inspected for design guidance, especially its hierarchy, spacing, typography, and control/stage relationship. The Tauri implementation should preserve recognizable visual DNA while simplifying the product around the new teleprompter workflow.

### 11.1 Overall character

The product should feel:

- editorial rather than dashboard-heavy;
- calm rather than playful;
- warm rather than sterile;
- precise rather than technical;
- deliberately sparse rather than unfinished.

Avoid:

- excessive rounded cards;
- saturated gradients;
- neon “AI” styling;
- glassmorphism;
- persistent animated indicators;
- giant empty hero areas inside the working application;
- tiny gray-on-gray text;
- generic component-library appearance.

### 11.2 Operator palette

Use a warm light interface for the control window:

```css
:root {
  --cc-bg: #f6f3ee;
  --cc-surface: #fbfaf7;
  --cc-surface-raised: #ffffff;
  --cc-text: #22201d;
  --cc-text-muted: #777168;
  --cc-border: #ded9d0;
  --cc-border-strong: #c9c1b6;
  --cc-accent: #4f4b8f;
  --cc-accent-hover: #45417e;
  --cc-accent-soft: #eeecf8;
  --cc-success: #2f6b4f;
  --cc-warning: #8a5b18;
  --cc-danger: #9b3d39;
  --cc-focus-ring: rgba(79, 75, 143, 0.32);
}
```

These are target values, not a requirement to ignore superior tokens already established in the Electron design. Preserve contrast ratios if adjusted.

### 11.3 Stage palette

```css
:root {
  --stage-bg: #080808;
  --stage-text: #f5f3ef;
  --stage-text-past: rgba(245, 243, 239, 0.42);
  --stage-text-future: rgba(245, 243, 239, 0.86);
  --stage-accent: rgba(210, 205, 255, 0.20);
  --stage-cue: #d8b46a;
  --stage-overlay: rgba(0, 0, 0, 0.72);
}
```

The user may select light stage themes later, but the default is near-black for teleprompter glass and camera-facing use.

### 11.4 Typography

### Control window

- Use a bundled or system UI sans-serif for controls and body copy.
- Use an editorial serif sparingly for major empty-state or document headings if it matches the existing Electron design.
- Do not load fonts from a remote service.
- Recommended system stack:

```css
font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif;
```

If Inter is bundled, include only the necessary weights and confirm licensing. A system-only stack is acceptable and keeps the package smaller.

### Stage

- Default to a highly legible sans-serif.
- Offer at least: System Sans, Humanist Sans, Serif, and Monospace.
- The default stage size is 64 logical pixels, line-height 1.32, weight 500.
- Compact displays such as 1024 × 600 should default closer to 38–44 logical pixels based on the saved display profile.
- Font size range: 24–160 px.
- Line-height range: 1.05–1.8.
- Letter-spacing range: -0.03em to 0.10em.

### 11.5 Spacing and shape

- Main horizontal page padding: 32 px.
- Compact toolbar padding: 16–20 px.
- Standard control height: 40 px.
- Primary action height: 42 px.
- Small control height: 32 px.
- Standard radius: 8 px.
- Large panel radius: 12 px.
- Use borders more often than shadows.
- Use only subtle shadows for menus, popovers, and floating sheets.

### 11.6 Motion

- Standard UI transition: 140–180 ms.
- Stage scroll motion is driven by the tracking spring, not generic CSS easing.
- Respect reduced-motion preferences.
- Do not animate decorative elements indefinitely.
- Listener video is the only persistent motion in the stage, and it must be dim enough not to compete with the script.

### 11.7 Icons

Use one coherent outline icon set, bundled locally. Icons supplement labels; they do not replace labels for primary actions. Avoid a mixture of platform-native symbols and web icon families in the same toolbar.

---

## 12. Script library screen

### 12.1 Layout

The script library is a two-pane view:

- **Sidebar:** 224–252 px wide.
- **Main content:** search, sort, and script list.

### Sidebar contents

1. CandidCue wordmark.
2. **New script** primary button.
3. Navigation:
   - All scripts;
   - Recent;
   - Favorites, only if favoriting is implemented;
   - Trash.
4. Optional user-created folders in a later release.
5. Footer:
   - Settings;
   - Help / keyboard shortcuts;
   - current application version in About, not permanently displayed.

### Main library header

- Title: “Scripts.”
- Search field with `Cmd/Ctrl+K` focus shortcut.
- Sort menu: Recently edited, Name, Created, Estimated length.
- Import button.

### 12.2 Script rows

Prefer a clean list over a grid of large cards. Each row contains:

- title;
- one-line plain-text excerpt;
- last edited relative date;
- word count or estimated speaking duration;
- optional status: prepared, vocabulary stale, missing asset;
- overflow menu.

Row actions:

- Open;
- Present;
- Duplicate;
- Export Markdown;
- Move to trash.

Double-click opens the editor. `Cmd/Ctrl+Enter` on the selected row opens Preflight.

### 12.3 Empty state

The first-run empty state includes:

- “Write the words. CandidCue keeps your place.”
- **Create a script** primary action.
- **Import Markdown** secondary action.
- A small sample-script action.

Do not show promotional illustrations or a feature carousel.

### 12.4 Trash behavior

- Trash is soft deletion.
- Items remain for 30 days by default or until manually emptied.
- Restoring returns the script and assets.
- Emptying trash requires confirmation and permanently removes script files, revisions, analysis cache, and unreferenced assets.

---

## 13. Editor screen

### 13.1 Header

The editor header contains:

- back-to-library control;
- editable script title;
- save state: “Saving…”, “Saved”, or actionable error;
- mode switch: Edit / Split / Preview;
- overflow menu;
- **Present** primary action.

The title is separate metadata, not inferred continuously from the first heading. On import, the file name becomes the initial title.

### 13.2 Editor body

### Edit mode

- CodeMirror 6 Markdown editor.
- Line wrapping on by default.
- Optional line numbers off by default.
- Markdown syntax is visible but visually restrained.
- Current heading appears in a slim breadcrumb above the editor when useful.

### Split mode

- Editor left, rendered preview right.
- Divider is draggable and remembered.
- Scrolling is loosely synchronized by block ID, not raw pixel percentage.

### Preview mode

- Full rendered document.
- Clicking a paragraph returns to Edit mode at its source location.
- Images and diagrams use the same renderer as the stage, within a lighter document theme.

### 13.3 Outline panel

A collapsible right panel contains:

- heading hierarchy;
- estimated duration by section;
- take markers;
- cue count;
- click-to-navigate behavior.

The outline is generated from compiled headings. Heading labels may have optional spoken aliases for commands.

### 13.4 Script vocabulary panel

A secondary tab in the outline panel shows:

- automatically detected terms;
- user-added terms;
- likely spoken variants;
- global or script-only scope;
- enable/disable control;
- **Re-analyze** action when the script hash changes.

Use honest copy:

> Vocabulary helps CandidCue match imperfect transcript words to your script. The current live transcription model does not accept a custom dictionary directly.

Do not imply that adding a term guarantees OpenAI will spell it correctly.

### 13.5 Autosave and revisions

- Debounce autosave by approximately 500 ms after typing stops.
- Save the canonical Markdown atomically.
- Create a lightweight revision on:
  - manual Save;
  - session start;
  - import;
  - destructive transform;
  - at most once every 15 minutes during sustained editing.
- Display an actionable local-save error; never silently continue with unsaved content.
- Do not require a visible Save button, but support `Cmd/Ctrl+S` and show a brief Saved state.

### 13.6 Insert controls

Keep the editor toolbar minimal:

- heading;
- bold;
- italic;
- link;
- cue;
- image;
- diagram block;
- take marker.

All actions insert plain Markdown or CandidCue’s documented extension syntax. The document must remain readable outside CandidCue.

---

## 14. Preflight screen

Preflight is the most important operational screen after the editor. It is a single scrollable page or large sheet, not a sequence of opaque modal steps. Returning users should be able to review everything at a glance.

### 14.1 Header

- Script title.
- Estimated duration.
- Overall status: Not ready / Checking / Ready / Ready with warning.
- **Start session** action remains visible in a sticky footer.

### 14.2 Preflight sections

### A. Stage display

Show detected displays as simple monitor tiles containing:

- user-friendly label;
- resolution;
- scale factor;
- primary-display badge;
- remembered profile name, if any.

Controls:

- selected display;
- **Identify displays**;
- **Open stage preview**;
- full screen toggle;
- always-on-top toggle for windowed stage;
- horizontal mirror;
- vertical mirror;
- remembered display profile.

A display is not considered validated until the stage window reports that it opened on the requested monitor.

### B. OpenAI connection

If no key is stored:

- password-style API key field;
- explanation that a dedicated project key is recommended;
- **Save and test**;
- link to the current OpenAI API-key page opened in the system browser.

If a key exists:

- masked value with final four characters only;
- Connected / Invalid / Rate limited / Network unavailable;
- Replace;
- Remove;
- Test connection.

Testing should create a valid short-lived transcription credential and dispose of it without starting a paid audio stream.

### C. Microphone

- device selector;
- option to follow the system default;
- live level meter;
- input status;
- **Test transcription** action;
- advanced audio processing disclosure.

The level meter should respond locally before any OpenAI call. The spoken transcription test opens a temporary realtime session and displays partial and final text.

### D. Voice tracking

Controls:

- mode: Voice follow / Manual / Fixed speed;
- language;
- latency preset: Fast, Balanced, Accurate;
- read headings aloud toggle;
- current wake phrase;
- command listening toggle;
- optional low-confidence accuracy boost, if implemented.

Preset mapping:

| UI preset | Realtime delay | Intended use |
|---|---|---|
| Fast | `minimal` | Lowest latency; may revise more often |
| Balanced | `low` | Default teleprompter setting |
| Accurate | `medium` | More context and steadier transcript at greater delay |

Do not expose `high` or `xhigh` in the normal UI; retain them in advanced diagnostics.

### E. Appearance

- font family;
- font size;
- line height;
- text column width;
- left/right offset;
- reading-band position;
- current phrase highlight;
- past-text dimming;
- top/bottom focus fade;
- stage background.

Changes update the live stage preview immediately.

### F. Listener

- None and installed Listener thumbnails;
- Browse Listener packs;
- dim amount;
- blur amount;
- scale;
- horizontal/vertical position;
- lens calibration;
- random playback toggle, always on in v1 unless diagnostic mode.

### G. Script readiness

- compiler status;
- missing local assets;
- unsupported remote assets;
- duplicate headings;
- wake-phrase collisions;
- stale vocabulary analysis;
- word count and estimated duration.

Warnings do not all block Start. Missing script compilation, invalid stage, invalid mic for voice mode, or invalid OpenAI connection do block Start. Wake-phrase collisions and stale analysis are warnings.

### 14.3 Sticky footer

Left side:

- summary such as “Stage ready · Mic ready · OpenAI ready.”

Right side:

- Cancel;
- **Start session**.

When not ready, the primary button remains disabled and a concise reason appears directly beside it. Do not make the user search for the failing section.

---

## 15. Live control screen

When a session starts, the control window switches to Live. The stage remains independent.

### 15.1 Live layout

### Top status bar

- script title;
- elapsed session time;
- mode badge: Voice / Manual / Fixed;
- connection state;
- microphone state;
- stage display name;
- unobtrusive estimated API cost for the current session, available in an info popover rather than permanently emphasized.

### Main area

Use a three-region layout on wide windows:

1. **Outline / navigation** — current chapter and nearby headings.
2. **Stage preview** — scaled representation of the actual output.
3. **Live diagnostics / adjustments** — tracking confidence, transcript tail, appearance shortcuts, and Listener controls.

On narrower windows, collapse diagnostics into tabs or a drawer. Do not shrink the stage preview into an unusable thumbnail.

### Bottom transport

- Start / Pause / Resume;
- Stop session;
- back one sentence;
- forward one sentence;
- restart paragraph;
- take marker;
- blank/unblank stage;
- voice-follow toggle;
- manual speed control when relevant.

The bottom transport is always visible.

### 15.2 Tracking visualization

The normal user sees:

- state: Following, Unsure, Searching, Paused, or Reconnecting;
- a simple confidence bar or dot;
- the latest short transcript tail;
- current script location.

A developer diagnostics panel, disabled by default, may expose:

- candidate scores;
- commit/item IDs;
- provisional vs finalized tokens;
- current alignment window;
- command-gate events;
- latency timings;
- WebRTC statistics.

Never display raw API keys, authorization headers, full scripts, or retained audio in diagnostics.

### 15.3 Pause semantics

CandidCue has two pause behaviors:

- **Listening pause:** automatic script movement stops, but the transcription session remains connected so the user can say “CandidCue, resume.” This can continue incurring OpenAI usage.
- **Hard pause:** the realtime connection closes. Manual controls remain available, but voice commands cannot resume the session. The user must click or use a keyboard shortcut.

The primary Pause button uses Listening pause. A menu beside it offers Hard pause. The UI must disclose the difference.

### 15.4 Ending a session

Stop closes the realtime connection immediately, stops microphone tracks, pauses Listener playback, and exits stage full screen. The stage may either close or remain as a blank window according to a user preference.

Show a compact summary in the control window:

- session duration;
- approximate realtime minutes/cost;
- ending location;
- number of explicit jumps/retakes, only if locally tracked;
- actions: Return to editor, Present again, Close stage.

Do not store a transcript by default.

---

## 16. Stage window specification

### 16.1 Layer model

The stage is composed of ordered layers:

1. solid background;
2. Listener video or optional background image;
3. Listener dim/blur/scrim treatment;
4. Markdown visual blocks such as images or diagrams;
5. script text;
6. focus fades and reading-band treatment;
7. optional transient command acknowledgement;
8. optional hidden diagnostics overlay.

Only a single inner **mirror plane** is transformed for teleprompter reflection. The control window and its calibration handles are never mirrored.

### 16.2 Default composition

- Background: near black.
- Text column width: 68% of stage width.
- Column centered horizontally.
- Reading band center: 38% from the top.
- Top and bottom padding: at least 38vh and 55vh respectively, allowing the first and last words to reach the band.
- Listener: centered behind the column, dimmed 78%, optional blur 1.5 px.
- Past text: fades to roughly 42% opacity.
- Current paragraph/future text: 86–100% opacity.
- Current phrase: subtle low-contrast rounded underlay, not a bright karaoke marker.

### 16.3 Reading-band behavior

The current token is allowed to move inside a narrow vertical dead zone before scrolling begins. Default band:

- upper boundary: 34% viewport height;
- lower boundary: 42% viewport height.

When the target token leaves the band, compute the scroll target that returns it to the band center. Move toward the target using a critically damped or near-critically damped spring.

Recommended initial constants, subject to evaluation:

```text
spring stiffness: 150
spring damping: 28
maximum normal velocity: 1200 logical px/s
maximum provisional correction: 180 logical px
```

Explicit jumps bypass the normal velocity cap and use one of two transitions:

- destination within approximately two viewport heights: smooth accelerated scroll;
- larger destination: 90 ms fade down, immediate reposition, 120 ms fade up.

### 16.4 Partial and final tracking display

- Provisional transcript matches may advance within the current paragraph or nearby blocks.
- Provisional matches may not trigger a large section jump or backward retake.
- Finalized matches may confirm larger movement if thresholds are met.
- If a final transcript revises an earlier partial, correct gently unless the current position is demonstrably wrong.

### 16.5 Manual intervention

Manual navigation immediately updates the tracking cursor and suspends automatic movement for a short grace period, default 2.5 seconds. Voice tracking then reacquires around the new location rather than snapping back to the old hypothesis.

### 16.6 Blank stage

Blank stage is instant and local. It replaces all visible stage layers with solid black while preserving session state and Listener playback position. The stage can be unblanked through the control window, shortcut, or voice command.

### 16.7 Mirror implementation

Horizontal mirroring is required in v1. Vertical mirroring may be exposed as an advanced option only when validated against supported hardware. Both are straightforward CSS transforms applied to the stage mirror plane:

```css
.stage-mirror-plane[data-mirror-x="true"] {
  transform: scaleX(-1);
}

.stage-mirror-plane[data-mirror-y="true"] {
  transform: scaleY(-1);
}

.stage-mirror-plane[data-mirror-x="true"][data-mirror-y="true"] {
  transform: scale(-1, -1);
}
```

The implementation must avoid composing these rules with positioning transforms on the same element. Use nested wrappers:

```html
<div class="stage-position-plane">
  <div class="stage-mirror-plane">
    <!-- listener and script -->
  </div>
</div>
```

Most physical teleprompter rigs require horizontal mirror only. Remember horizontal—and vertical when shipped—per display profile.

### 16.8 Compact-display adaptation

For a display around 1024 × 600:

- default text size: 40 px;
- column width: 82%;
- reduced top/bottom fade depth;
- Listener framed around the upper torso or face;
- fewer visible controls in stage preview;
- images constrained to 70% viewport height.

Display profiles should store user overrides so a compact prompter and a large second monitor can have different settings.

### 16.9 Stage pointer and keyboard behavior

During full-screen prompting:

- hide the pointer after 1.5 seconds of inactivity;
- a single click focuses the stage but does not move the script;
- Escape exits full screen only after a short confirmation toast in the control window or if pressed twice within 1.5 seconds;
- stage-local arrow and space controls may be enabled, but global shortcuts are handled in the Rust layer where possible.

---

## 17. Lens and Listener calibration

### 17.1 Calibration purpose

The user must be able to place the Listener’s eyes, and optionally the script column, as close as possible to the physical camera lens. The app cannot detect the lens automatically because it has no camera access and may be used with reflected glass.

### 17.2 Calibration mode

When the user presses **Calibrate lens**:

1. The stage shows a high-contrast crosshair.
2. The control window displays a miniature stage with draggable crosshair coordinates.
3. The user physically looks at the camera and moves the crosshair until it appears directly over the lens through the teleprompter.
4. The app stores normalized coordinates from 0.0 to 1.0 in the display profile.
5. If a Listener is selected, its defined eye anchor can snap to that point.
6. The user can offset the text column relative to the lens by dragging it or entering horizontal/vertical offsets.

### 17.3 Listener positioning parameters

Store:

- normalized eye-anchor target;
- media scale;
- x/y translation;
- crop mode: cover, contain, portrait crop;
- optional horizontal flip independent of teleprompter mirror;
- dim percentage;
- blur radius;
- saturation percentage;
- vignette amount.

Reset returns to the pack’s recommended values for the current aspect ratio.

---

## 18. Settings screen

Settings are divided into seven sections.

### 18.1 General

- launch behavior: library or most recent script;
- default session mode;
- autosave and revision retention;
- restore open windows;
- confirm before ending an active session;
- application language when localization exists.

### 18.2 OpenAI

- stored-key status;
- replace/remove/test key;
- realtime transcription model, shown as advanced and defaulting to `gpt-realtime-whisper`;
- command model, default `gpt-5.6-luna`;
- script analysis toggle;
- natural-language command fallback toggle;
- `store: false` for Responses requests, fixed on and explained;
- usage estimate and current published rates with a “rates can change” note;
- data-handling explanation.

Do not let a user enter an arbitrary API base URL in normal settings. That creates a credential-exfiltration risk. A development build may support an environment-controlled test endpoint.

### 18.3 Audio

- preferred microphone;
- follow system default;
- noise suppression;
- echo cancellation;
- automatic gain control;
- input-level calibration;
- local VAD sensitivity;
- test meter and transcription test;
- reset microphone permission instructions.

Audio-processing controls must accurately reflect browser/platform support. Unsupported constraints are disabled rather than silently ignored.

### 18.4 Teleprompter

- default display profile;
- typography defaults;
- mirror defaults;
- reading-band position;
- current phrase treatment;
- fixed-speed default in words per minute;
- stage close/blank behavior at session end;
- pointer hiding.

### 18.5 Commands

- voice commands enabled;
- wake phrase;
- accepted wake aliases;
- strict mode: wake phrase required;
- collision scan;
- command list and examples;
- reset defaults;
- optional push-to-command shortcut.

### 18.6 Listeners

- installed packs;
- download/remove/update;
- default Listener;
- autoplay and dim defaults;
- local cache size;
- asset storage location display.

### 18.7 Data, privacy, and updates

- script data folder;
- export all scripts;
- reveal data folder;
- clear analysis cache;
- clear Listener downloads;
- clear logs;
- diagnostic logging toggle;
- crash-report opt-in, if implemented;
- update channel: Stable, optionally Beta;
- check for updates;
- current version;
- privacy summary and source links.

---

## 19. Keyboard shortcuts

Default shortcuts must use `Command` on macOS and `Ctrl` on Windows.

| Action | Shortcut |
|---|---|
| New script | `Cmd/Ctrl+N` |
| Open quick search | `Cmd/Ctrl+K` |
| Save | `Cmd/Ctrl+S` |
| Present current script | `Cmd/Ctrl+Enter` |
| Start/Pause/Resume | `Space` when not typing |
| Hard pause | `Cmd/Ctrl+Shift+Space` |
| Stop session | `Cmd/Ctrl+.` |
| Back one sentence | `Alt+Left` |
| Forward one sentence | `Alt+Right` |
| Previous chapter | `Alt+Up` |
| Next chapter | `Alt+Down` |
| Increase stage text | `Cmd/Ctrl+=` |
| Decrease stage text | `Cmd/Ctrl+-` |
| Toggle horizontal mirror | `Cmd/Ctrl+Shift+M` |
| Blank stage | `B` during Live |
| Toggle Listener | `L` during Live |
| Add take marker | `T` during Live |
| Exit stage full screen | `Esc` |
| Command help | `Cmd/Ctrl+/` |

Global shortcuts are optional and off by default. When enabled, register a small user-configurable set and surface conflicts clearly.

---

## 20. Accessibility

- Every control-window action must be keyboard reachable.
- Use visible focus indicators.
- Provide semantic labels and accessible names for icon buttons.
- Announce save, connection, and permission errors through an ARIA live region without repeatedly announcing streaming transcript text.
- Do not rely on color alone for readiness.
- Respect reduced motion in control UI and stage transitions.
- Provide high-contrast stage themes.
- Allow the current phrase highlight and past-text dimming to be disabled.
- Support minimum 200% control-window zoom without losing core actions.
- The stage itself is a visual reading surface; screen-reader support applies primarily to control and editor workflows.

---
# Part III — Script documents and preparation

## 21. Script document model and lifecycle

### 21.1 Canonical source

Every CandidCue script has one canonical Markdown file. SQLite indexes and metadata support the product, but the Markdown file is the recoverable source of truth for the authored content.

A script record consists of:

- immutable UUID;
- user-visible title;
- canonical `script.md` path;
- optional imported source path for provenance only;
- creation and modification timestamps;
- last-opened timestamp;
- status: Draft, Ready, or Archived;
- selected display profile;
- selected tracking profile;
- selected Listener and Listener layout;
- per-script dictionary and generated vocabulary analysis;
- compiled-document hash and compiler version;
- optional session start location;
- revision pointers;
- soft-delete timestamp, if in Trash.

Do not encode application metadata in YAML front matter in v1. This keeps imported Markdown clean and prevents app settings from unexpectedly appearing in other editors. Store metadata in SQLite and export a companion JSON file only when exporting a complete CandidCue bundle.

### 21.2 Creation

Supported creation paths:

1. **Blank script** — title is selected and the editor opens with an empty document.
2. **Paste into editor** — standard clipboard behavior, with optional “Paste as plain text.”
3. **Import Markdown** — copy the file into CandidCue’s managed script directory; do not edit the original external file.
4. **Import plain text** — convert line breaks conservatively into Markdown paragraphs.
5. **Duplicate script** — copy source, assets, and applicable script-level settings; generate a new UUID.
6. **Create from template** — small built-in set only: Blank, Talking-head video, Product demo, Course lesson. Templates contain lightweight headings and cue examples, not generated prose.

### 21.3 Saving

- Autosave after 600 ms of editor inactivity.
- Save immediately on focus loss, navigation, Present, application close, and explicit save.
- Write to a temporary file in the same directory, `fsync` where practical, then atomically rename.
- Update the database only after the canonical file has been written successfully.
- Show `Saving…`, `Saved`, or `Save failed` in the editor header.
- A save failure must preserve the unsaved editor buffer and offer Retry, Copy all text, and Reveal data folder.
- Never silently overwrite a file that has changed outside the application since its last read. Display a three-way resolution screen: Keep CandidCue version, Load disk version, or Save both.

### 21.4 Revisions

Create lightweight local revisions:

- on first save after import;
- before replacing the editor buffer from disk;
- before destructive whole-document operations;
- no more than once every five minutes during active editing;
- immediately before a session begins if the document changed since the previous revision.

Retention defaults:

- all revisions from the last 24 hours;
- one per day for 30 days;
- one per week thereafter;
- maximum 100 revisions per script;
- never delete the current canonical source.

Revision browser requirements:

- date and time;
- character and word count difference;
- read-only preview;
- Restore as current, which first saves the current version as a revision;
- Export revision.

A full visual diff is useful but not required for v1.0.

### 21.5 Trash and deletion

Deleting a script moves it to Trash for 30 days. Trash supports Restore and Delete permanently. Permanent deletion removes:

- canonical source;
- revisions;
- copied assets not referenced by another script;
- compiled caches;
- script-specific analysis;
- database rows.

A Listener pack, global dictionary entry, or display profile is never deleted with a script.

### 21.6 Import and export

#### Import

Accepted v1 formats:

- `.md`, `.markdown`;
- `.txt`;
- CandidCue bundle `.candidcue`.

A `.candidcue` file is a ZIP-compatible bundle with a fixed schema:

```text
manifest.json
script.md
assets/
  <sha256>.<extension>
```

The importer must reject:

- path traversal;
- absolute paths;
- symlinks;
- undeclared files beyond a reasonable allowance;
- files above configurable size limits;
- executable content;
- malformed manifests;
- decompression bombs.

#### Export

Support:

- Markdown only;
- plain text, with non-spoken content omitted or represented according to export settings;
- self-contained CandidCue bundle;
- printable HTML or PDF as a later enhancement, not a v1 release requirement.

When exporting Markdown only, offer either:

- leave asset references as relative paths and export an adjacent assets folder; or
- omit unsupported local images with a clear warning.

### 21.7 External editing

CandidCue is not a live filesystem-backed editor in v1. Imported files are copied into managed storage. This avoids permission persistence, sandbox scope, and conflict complexity. The user may reveal the managed Markdown file and edit it externally, but CandidCue detects changes and asks how to resolve them.

### 21.8 Word counts and timing estimates

For every compiled script, show:

- total spoken words;
- estimated duration at the configured words per minute;
- current chapter’s spoken words and duration;
- excluded/non-spoken block count;
- number of images, diagrams, and cue blocks;
- vocabulary-analysis status.

Use spoken tokens, not raw Markdown tokens, for estimates. Default delivery speed is 130 words per minute and is user-configurable from 70 to 220.

---

## 22. Markdown contract

### 22.1 Supported baseline

CandidCue supports CommonMark plus the practical GitHub-Flavored Markdown features listed below:

- ATX headings (`#` through `######`);
- paragraphs and hard line breaks;
- emphasis and strong emphasis;
- ordered and unordered lists;
- blockquotes;
- links;
- images;
- horizontal rules;
- fenced code blocks;
- inline code;
- tables;
- task-list syntax;
- strikethrough;
- HTML comments;
- CandidCue directives defined in section 23.

Raw HTML is disabled. Do not provide a setting to enable arbitrary HTML in v1.

### 22.2 Spoken-content semantics

The compiler converts the visual Markdown tree into a separate **spoken stream** used by timing, transcription alignment, and tracking. The visual tree and spoken stream are related but not identical.

Default rules:

| Markdown element | Rendered on stage | Spoken by default | Spoken representation |
|---|---:|---:|---|
| Paragraph | Yes | Yes | Plain textual content |
| Heading | Yes | No | Optional heading text |
| Strong/emphasis | Yes | Yes | Plain textual content |
| Link | Yes | Yes | Link label only; never URL |
| Ordered/unordered list item | Yes | Yes | Item text; marker omitted |
| Blockquote | Yes | Yes | Quote text |
| Inline code | Yes | Optional | Literal code tokenization |
| Fenced code | Optional visual card | No | None |
| Table | Optional visual card | No | None by default |
| Image | Yes | No | Alt text only when explicitly enabled |
| Mermaid diagram | Yes | No | None |
| Horizontal rule | Yes | No | Section boundary |
| Task-list checkbox | Yes | Yes | Item text; checkbox omitted |
| Strikethrough | Yes | Yes | Text remains spoken |
| HTML comment | No | No | None |
| Cue directive | Optional cue overlay | No | None |

Per-script switches may enable “Read headings,” “Read image alt text,” or “Read inline code.” Do not make table cells or fenced code spoken automatically because their reading order is often ambiguous and alignment-hostile.

### 22.3 Paragraph and line-break behavior

- A blank line creates a new block and a natural navigation unit.
- A soft line break inside a paragraph does not create a navigation unit.
- Two trailing spaces or an explicit hard break create a rendered line break but remain part of the same spoken paragraph.
- The compiler may wrap visually at any point; visual wrapping never changes token identity or source position.
- A single sentence may span formatting nodes and links but still forms one sentence navigation unit.

### 22.4 Heading hierarchy

Headings create the document outline.

- H1: title-level chapter or major part.
- H2: chapter/section.
- H3–H6: nested subsections.
- If a document contains no headings, create one synthetic section named “Script.”
- If content appears before the first heading, put it in a synthetic “Opening” section.
- Duplicate headings are allowed and receive stable internal IDs based on source order and content hash.
- Spoken commands referring to a duplicate heading should ask for clarification in the control window or use an ordinal: “the second Results section.”

### 22.5 Visual rendering modes

The compiler produces one semantic document, rendered through three presentations:

1. **Editor preview** — close to standard Markdown, with authored formatting visible.
2. **Reading preview** — stage typography and cue treatment within the control window.
3. **Live stage** — optimized for distance, stable tracking, and minimal distraction.

Never compile different spoken streams for these views. The same token IDs and block IDs must survive all rendering modes.

### 22.6 Sanitization

The render pipeline must:

- parse Markdown to an abstract syntax tree;
- transform supported CandidCue directives explicitly;
- reject raw HTML nodes;
- sanitize generated HTML against an allowlist;
- reject event-handler attributes, scripts, iframes, embeds, forms, and arbitrary styles;
- rewrite local asset URLs through an application-controlled asset resolver;
- block remote network loads by default;
- add no user-provided content to `innerHTML` outside the sanitized compiler output.

Use a tested `unified`/`remark`/`rehype` pipeline or equivalent. Keep the compiler in a versioned package with golden fixtures, rather than assembling ad hoc regular expressions in components.

### 22.7 Unsupported syntax

Unknown directives and unsupported Markdown extensions must render as readable source text in the editor and produce a non-blocking preparation warning. They must never disappear silently.

---

## 23. CandidCue directive syntax

### 23.1 Design principles

Custom syntax should remain readable when opened in another Markdown editor. Prefer bracketed inline directives and fenced blocks over hidden binary metadata.

Directives are case-insensitive for the directive name, preserve user text, and support quoted values where needed.

### 23.2 Inline cue

```markdown
[Cue: smile and hold eye contact]
```

Behavior:

- excluded from the spoken stream;
- rendered as a small, visually distinct cue chip or margin note;
- may enter the stage viewport before the associated sentence;
- does not move the alignment cursor;
- cue styling is configurable: hidden, subtle, or prominent.

Shorthand:

```markdown
[Pause]
[Beat]
[Breathe]
```

These map to built-in cue types with icons or labels. They are still not timed pauses enforced by the software.

### 23.3 Take marker

```markdown
[Take: Opening]
```

A take marker creates a named navigation target and a visible divider in the control timeline. It does not create a chapter in the Markdown outline. Voice examples:

- “CandidCue, go to take Opening.”
- “CandidCue, restart this take.”

Duplicate take names are allowed but should trigger a readiness warning.

### 23.4 Spoken override

Use a block directive when visual text and expected spoken text differ materially:

```markdown
:::spoken
visual: CandidCue v2.0
say: Candid Cue version two point oh
:::
```

Rules:

- visual text is rendered;
- `say` text enters the alignment stream;
- both fields are plain text, not nested Markdown;
- the editor provides an insertion dialog so users need not memorize syntax;
- use sparingly; the vocabulary system should handle ordinary variants.

A compact inline alternative is permitted for short terms:

```markdown
CandidCue{say="Candid Cue"}
```

The compiler must preserve the visual token’s source range while associating it with one or more spoken aliases.

### 23.5 Non-spoken block

```markdown
:::silent
This note appears in the rendered script but is excluded from speech tracking.
:::
```

Use cases include camera directions, production notes, or charts. Render with a distinct production-note treatment. The stage may hide silent blocks entirely or show them as dim reference cards.

### 23.6 Stage-only block

```markdown
:::stage
Key result: **42% faster**
:::
```

This content appears in reading preview and on the stage but can be collapsed in the editor’s prose view. It remains non-spoken unless nested text is explicitly marked as spoken. This is useful for a visual figure or reference that should accompany the next spoken block.

### 23.7 Command-safe literal

If the script genuinely contains the wake phrase and a command-like sentence, allow the author to mark it as ordinary speech:

```markdown
:::literal-command
CandidCue, go to chapter one.
:::
```

This content remains spoken and alignable, and command detection is suppressed while the alignment cursor is inside or immediately around the block. The preparation screen should suggest this directive when it detects collisions.

### 23.8 Directive error handling

Malformed directives:

- remain visible as source in the editor;
- render as a warning card in preview;
- block “Ready” only if they alter spoken text or navigation targets ambiguously;
- provide a one-click “Open at error” action.

---

## 24. Images, diagrams, tables, and visual assets

### 24.1 Image import

Users can add an image by:

- dragging a file into the editor;
- pasting from the clipboard;
- using Insert → Image;
- importing a Markdown bundle containing declared assets.

On import:

1. Read the file through the Rust core.
2. Validate MIME type from content, not only extension.
3. Reject unsupported or dangerous formats.
4. Compute SHA-256.
5. Copy to the script’s assets directory using the hash as filename.
6. Generate an application-relative reference.
7. Add or update the database asset record.

Supported v1 formats:

- PNG;
- JPEG;
- WebP;
- SVG only after strict sanitization, or defer SVG entirely for the first release if the sanitizer is not proven.

Recommended limits:

- 25 MB per source image;
- 100 megapixels decoded dimensions;
- 500 MB total assets per script before a warning;
- optional downscaled stage derivative for very large images.

### 24.2 Remote images

Remote image URLs are not loaded automatically. They can leak document access, fail during a take, and create inconsistent performance.

When a user pastes a remote URL, show:

- Import a local copy;
- Keep as blocked link;
- Cancel.

“Import a local copy” downloads through the Rust core with redirects and size constrained, validates the content, and stores it locally. The original URL may be retained as provenance metadata.

### 24.3 Stage image layout

Images can be configured per block:

- inline with text;
- above text;
- below text;
- full-stage reference;
- side panel left or right;
- hidden on stage.

The default is inline, constrained to 45% of available stage height. Images must never cause text position to reflow after a session begins. Decode and measure all visible images during preflight. Reserve exact layout space before opening Live mode.

When the active spoken paragraph is associated with a large visual block, the stage may smoothly transition to a split layout. This transition must be deterministic from block position, not inferred by an LLM.

### 24.4 Image association

An image belongs to the next spoken block unless separated by a heading or horizontal rule. The editor allows changing association to:

- previous paragraph;
- next paragraph;
- entire section;
- no spoken block.

Association affects when it enters and leaves the stage viewport but not alignment.

### 24.5 Mermaid diagrams

Support fenced Mermaid blocks only after the following conditions are met:

````markdown
```mermaid
flowchart LR
  A --> B
```
````

- render in strict security mode;
- disable click handlers and external links;
- do not allow arbitrary HTML labels;
- render to an inert SVG or canvas during preparation;
- cache the result by content hash;
- show compiler errors in the control window, never on stage during a take;
- diagrams are non-spoken by default.

If safe Mermaid rendering materially expands v1 scope, ship it behind an experimental setting or move it to v1.1. Standard images are mandatory; Mermaid is not.

### 24.6 Tables

Tables render as compact reference cards. Stage behavior:

- no horizontal overflow on the reading display;
- scale down to a configured minimum, then switch to a vertically stacked representation;
- freeze dimensions during the session;
- non-spoken by default;
- can be hidden from stage without deleting source.

Do not attempt to track the speaker through arbitrary table-cell content in v1.

### 24.7 Graphs

CandidCue does not include a chart authoring engine in v1. Graphs should be imported as images or rendered from Mermaid where supported. A later version may add Vega-Lite or a constrained chart block, but arbitrary JavaScript visualization specifications are prohibited.

### 24.8 Asset garbage collection

An asset is eligible for deletion when:

- no canonical script references it;
- no retained revision references it;
- it is not part of an active export operation;
- it has remained unreferenced for at least seven days.

Run garbage collection on startup at most once per day and after permanent script deletion. Never delete files merely because the current editor buffer temporarily removed a reference.

---

## 25. Script compiler and intermediate representation

### 25.1 Compiler responsibilities

The compiler is deterministic and versioned. Given Markdown text and compile settings, it produces:

- sanitized visual document tree;
- document outline;
- navigation targets;
- spoken blocks;
- sentence units;
- normalized tokens and aliases;
- mapping from spoken tokens to source ranges and visual DOM keys;
- visual asset manifest;
- cue timeline;
- command-collision warnings;
- readiness diagnostics;
- aggregate statistics.

The compiler does **not** call OpenAI. Vocabulary analysis is a separate, cached preparation stage.

### 25.2 Stable identities

Each block receives a stable ID derived from:

- script UUID;
- block type;
- normalized block text hash;
- nearby structural context;
- ordinal fallback.

The goal is to preserve IDs after edits elsewhere in the document. Exact permanence is not guaranteed, but ordinary insertions above a paragraph should not invalidate all later IDs.

Each spoken token receives:

- global sequence index;
- block ID;
- sentence ID;
- source start and end offsets in UTF-16 and UTF-8 coordinates as needed;
- visual node key;
- normalized form;
- surface form;
- aliases;
- token weight;
- flags such as punctuation, stopword, number, proper noun, directive alias, or non-navigation token.

### 25.3 Intermediate representation

Illustrative TypeScript contract:

```ts
export interface CompiledScript {
  schemaVersion: number;
  compilerVersion: string;
  scriptId: string;
  sourceHash: string;
  settingsHash: string;
  title: string;
  outline: OutlineNode[];
  blocks: CompiledBlock[];
  spokenTokens: SpokenToken[];
  sentences: SentenceUnit[];
  navigationTargets: NavigationTarget[];
  cues: CueEvent[];
  assets: CompiledAsset[];
  diagnostics: CompileDiagnostic[];
  statistics: ScriptStatistics;
  indexes: SerializedSearchIndexes;
}

export interface SpokenToken {
  index: number;
  blockId: string;
  sentenceId: string;
  surface: string;
  normalized: string;
  aliases: string[];
  weight: number;
  source: { utf16Start: number; utf16End: number };
  flags: number;
}
```

Do not send the entire `CompiledScript` over Tauri IPC for every tracking update. Load it once into both windows or expose a compact stage representation, then exchange small immutable snapshots.

### 25.4 Normalization

Normalization must be language-aware enough to support English robustly in v1 while remaining extensible.

Baseline pipeline:

1. Unicode normalize to NFKC.
2. Standardize smart quotes and apostrophes.
3. Lowercase using locale-safe rules.
4. Normalize dash and hyphen variants.
5. Remove punctuation that does not alter lexical identity.
6. Preserve apostrophes in contractions while also generating split aliases.
7. Expand common symbols where context is clear: `%` → “percent,” `&` → “and.”
8. Generate number alternatives: `42`, “forty two,” and “forty-two.”
9. Normalize common abbreviations and titles through a bounded dictionary.
10. Collapse whitespace.
11. Preserve a mapping back to the unmodified source.

Do not stem aggressively. “Design,” “designer,” and “designed” are useful distinct anchors. Optional light morphological similarity belongs in the matcher, not destructive source normalization.

### 25.5 Sentence segmentation

Use a proper sentence segmenter with exceptions for abbreviations, decimals, initials, URLs, and honorifics. The parser should treat:

- `Mr. Smith` as one sentence fragment;
- `3.14` as a number;
- `e.g.` as an abbreviation;
- cue directives as boundaries only when structurally separate;
- list items as navigation units even without terminal punctuation.

Sentence segmentation is used for manual navigation and retake heuristics, so it must have golden tests.

### 25.6 Search indexes

Compile the following indexes:

- exact normalized token → positions;
- rare token → positions;
- two-, three-, and four-token normalized n-grams → positions;
- phonetic key → candidate positions;
- heading/take name normalized index;
- sentence text normalized index;
- paragraph opening phrase index.

Use indexes to generate candidates; do not use them as the final alignment score.

### 25.7 Token weights

Indicative defaults:

| Token class | Weight |
|---|---:|
| Stopword or filler-like common word | 0.35 |
| Common content word | 1.00 |
| Less common content word | 1.20 |
| Proper noun or script-specific term | 1.50 |
| Explicit spoken override anchor | 1.65 |
| Pure punctuation | 0.00 |

Weights may also include inverse document frequency computed within the script. Clamp the final weight to avoid one unusual token forcing a global jump.

### 25.8 Compilation performance

Targets on a normal 2024-era laptop:

- 5,000 spoken words: under 100 ms after parser warm-up;
- 25,000 spoken words: under 400 ms;
- no control-window freeze longer than one animation frame for incremental editing;
- full compile may run in a worker; preview can update incrementally.

Do not re-run vocabulary analysis on every keystroke. Recompile local structures immediately, debounce expensive readiness checks, and analyze only on explicit preparation or after a meaningful content change.

---

## 26. Script vocabulary and pronunciation preparation

### 26.1 Verified API constraint

CandidCue must not assume that the primary `gpt-realtime-whisper` session can accept a custom prompt or dictionary. In the current Realtime transcription interface, this model does not provide prompt steering. The application therefore uses script-specific vocabulary as **alignment knowledge**, not as a hidden Realtime model parameter.

The implementation must isolate this assumption behind model capability metadata. If a future supported Realtime transcription model accepts prompt vocabulary, it can be enabled without changing the script-analysis format.

### 26.2 Goals

Vocabulary preparation should improve:

- matching of product names, people, places, acronyms, and technical terms;
- tolerance of common transcription substitutions;
- command collision detection;
- heading and take navigation;
- optional post-transcription correction.

It should not:

- alter the authored script automatically;
- expose a complex linguistic workflow to ordinary users;
- send every script to a model without disclosure;
- claim to train or permanently customize the speech model.

### 26.3 Sources of vocabulary

Merge four sources in priority order:

1. **Explicit spoken overrides** in the document.
2. **User dictionary** entries, global or script-specific.
3. **Deterministic local extraction** from the script.
4. **Optional Luna analysis** to classify and enrich candidates.

An explicit user entry always wins over generated analysis.

### 26.4 Local candidate extraction

The local analyzer identifies:

- capitalized multiword phrases not merely sentence starts;
- CamelCase and mixed-case brand names;
- acronyms and initialisms;
- tokens containing digits;
- low-frequency words;
- hyphenated compounds;
- email-like and domain-like strings;
- terms in headings;
- repeated names and technical phrases;
- explicit visual/spoken mismatch directives.

It should exclude ordinary common words, Markdown syntax, URLs as URLs, and extremely long opaque hashes.

### 26.5 Optional Luna enrichment

When “Smart vocabulary analysis” is enabled, send:

- the locally extracted candidates;
- a small amount of surrounding context;
- the document language;
- user dictionary entries relevant to the candidates.

Do not send the entire script unless necessary and disclosed. For scripts below a modest token threshold, full-text analysis can be an explicit implementation choice, but candidate-plus-context is preferred for cost and privacy.

Use `gpt-5.6-luna` with a strict structured response. Expected output:

```json
{
  "terms": [
    {
      "surface": "CandidCue",
      "canonical_spoken": "Candid Cue",
      "aliases": ["candy cue", "candid q"],
      "category": "brand",
      "importance": 0.96,
      "case_sensitive": true,
      "notes": "Application name"
    }
  ]
}
```

The model may suggest likely ASR confusions, but the application labels them as generated and allows edit or removal. Never let a model-generated alias become a command wake alias without explicit user approval.

### 26.6 Dictionary editor

The setup page and Settings provide a simple dictionary table:

| Written term | Expected speech | Accepted transcript aliases | Scope |
|---|---|---|---|
| CandidCue | Candid Cue | candy cue; candid q | Global |
| RuinWeave | Ruin Weave | ruin weave; rune weave | Script |

Features:

- add, edit, duplicate, delete;
- test by speaking the word;
- show the latest raw transcript result;
- add the transcript as an accepted alias;
- mark “use only in this script”;
- import/export JSON or CSV later, not required for first release;
- prevent empty entries and unbounded alias lists.

The microphone test should explain the truth: “These terms improve CandidCue’s matching. They are not currently uploaded as a custom Realtime dictionary.”

### 26.7 Analysis cache

Cache vocabulary analysis by:

- source content hash;
- local extractor version;
- model identifier;
- prompt/schema version;
- relevant global dictionary version;
- language.

A small script edit should reuse unchanged candidate analysis when possible. The user can clear or regenerate analysis.

### 26.8 Optional selective correction layer

A later “Accuracy boost” mode may retain a short rolling audio buffer and submit only a low-confidence segment to a non-Realtime transcription endpoint that supports a prompt containing nearby script terms. This is not required for the v1 tracking path because it adds delay, duplicate audio processing, privacy disclosure, and cost.

If implemented:

- it must be opt-in;
- use only segments the alignment engine marks uncertain;
- limit the prompt to relevant nearby terms;
- never wait for correction before rendering ordinary forward progress;
- reconcile corrected text by transcript item ID and time range;
- discard audio immediately after correction;
- expose separate cost and privacy text;
- measure whether it materially improves the evaluation corpus before shipping.

---
# Part IV — Voice tracking and hands-free control

## 27. OpenAI integration architecture

### 27.1 Separation of concerns

Use three distinct OpenAI operations:

1. **Realtime transcription** — continuous microphone speech-to-text through a transcription-only Realtime session using `gpt-realtime-whisper`.
2. **Command interpretation** — infrequent, text-only `gpt-5.6-luna` requests for commands that the deterministic parser cannot resolve safely.
3. **Vocabulary analysis** — occasional, text-only `gpt-5.6-luna` requests during script preparation.

Do not use a speaking Realtime assistant. CandidCue has no model-generated voice, no conversational response, and no reason to pay for or expose a general audio agent session.

### 27.2 Trust boundary

After the user submits the key through a one-shot masked input, the saved OpenAI API key lives only in the Rust process and an operating-system-backed credential store. The frontend may request:

- a short-lived Realtime client secret scoped to a transcription session;
- the result of a bounded Luna operation;
- key validation status with redacted metadata.

Rust must never return the saved permanent key to the frontend through IPC or expose it through environment variables, URL parameters, page source, local storage, IndexedDB, session storage, crash context, analytics, or logs. The initial candidate necessarily exists briefly in the control webview while the user types it; keep it out of application stores, submit it directly to a one-shot command, clear the DOM field and component buffer immediately, and verify that it is absent from logs, snapshots, and persisted state.

### 27.3 Primary Realtime transport

The primary transport is browser WebRTC inside the **control window**:

1. User starts tracking.
2. Control frontend invokes `create_realtime_transcription_credential` in Rust.
3. Rust loads the permanent key and calls the OpenAI client-secret endpoint with a transcription-session configuration.
4. Rust returns only the short-lived client secret and non-sensitive expiry metadata.
5. The control window creates an `RTCPeerConnection`.
6. The selected microphone track is attached to the peer connection.
7. A data channel carries Realtime client events and transcript server events.
8. The control window applies local VAD and sends manual commit events at speech boundaries.
9. Transcript deltas and completions enter the transcript reconciler.
10. Tracking snapshots are emitted to the stage.

This follows the browser-client pattern while preserving the permanent key in a trusted backend. In CandidCue, the Rust process takes the role normally occupied by a developer-controlled web server.

### 27.4 Transport abstraction and fallback

Create a frontend-facing interface:

```ts
export interface RealtimeTranscriptionTransport {
  connect(config: TranscriptionConfig): Promise<void>;
  setMicrophone(deviceId: string): Promise<void>;
  commit(reason: CommitReason): void;
  clearBufferedAudio(): void;
  disconnect(reason: DisconnectReason): Promise<void>;
  onEvent(handler: (event: TranscriptionEvent) => void): Unsubscribe;
  getDiagnostics(): TransportDiagnostics;
}
```

Implement `WebRtcTranscriptionTransport` first.

Also define, but do not necessarily ship initially, `RustWebSocketTranscriptionTransport`. The fallback captures or receives PCM, resamples to 24 kHz mono PCM16, and streams through a native Rust WebSocket. This is the contingency if the Phase 0 spike finds that WebRTC behavior inside a target system WebView is unreliable, manual commit semantics are inadequate, or microphone switching cannot meet release criteria.

The rest of the app—transcript reconciler, aligner, command router, UI state—must not depend on transport-specific OpenAI event objects.

### 27.5 Session configuration

Initial configuration:

```json
{
  "type": "transcription",
  "audio": {
    "input": {
      "transcription": {
        "model": "gpt-realtime-whisper",
        "language": "en",
        "delay": "low"
      },
      "turn_detection": null,
      "noise_reduction": {
        "type": "near_field"
      }
    }
  },
  "include": [
    "item.input_audio_transcription.logprobs"
  ]
}
```

Treat this as a starting point, not an immutable constant:

- default delay: `low` if evaluation meets accuracy; otherwise `medium`;
- Advanced setting exposes Low latency, Balanced, and Higher accuracy, mapped to tested delay values;
- language defaults to English but is stored as a model/session capability;
- request log probabilities only when the selected model and endpoint return them consistently;
- absence of log probabilities must not break matching;
- verify current noise-reduction support and accepted values against the API schema during implementation.

Because the API’s concrete latency for each delay level is not fixed, select defaults from the CandidCue audio corpus rather than from assumptions.

### 27.6 API client implementation

Rust owns one `OpenAiClient` with:

- explicit request timeouts;
- TLS through a maintained HTTP client;
- no automatic logging of request bodies or authorization headers;
- bounded retries for idempotent operations only;
- rate-limit and quota classification;
- response-size limits;
- typed deserialization with an unknown-field tolerance appropriate to forward-compatible API responses;
- an injectable clock and HTTP adapter for tests;
- model and endpoint identifiers defined in remotely updatable capability metadata or application constants, not repeated throughout components.

Never retry a command automatically after an ambiguous network failure if the command could be applied twice. Associate each command request with a local idempotency ID and apply at most one validated result.

### 27.7 Key validation

When the user saves a key:

1. Trim surrounding whitespace without altering internal characters.
2. Store it provisionally in memory.
3. Make the least expensive practical authenticated request that confirms access to required endpoints.
4. Classify the result:
   - Valid and ready;
   - Valid, but Realtime unavailable;
   - Valid, but model unavailable;
   - Insufficient quota or billing issue;
   - Invalid/revoked;
   - Network/TLS/proxy error;
   - OpenAI service error.
5. Store only after the user confirms Save or the validation succeeds, according to final UX.
6. Display the key only as a redacted suffix after save.

“Valid” must not be inferred from prefix format.

### 27.8 Model capability registry

Add a small versioned registry:

```ts
interface ModelCapabilities {
  realtimeModel: string;
  commandModel: string;
  realtimePromptSteering: boolean;
  realtimeLogprobs: boolean;
  supportedDelayLevels: string[];
  supportsClientSecretForTranscription: boolean;
  commandStructuredOutputs: boolean;
}
```

The registry allows a controlled update when model names or capabilities change. It must not permit arbitrary remote endpoint substitution or downloaded executable logic.

---

## 28. Microphone permissions, selection, and audio diagnostics

### 28.1 Permission flow

Do not request microphone permission on application launch. Request it when the user reaches the microphone step in onboarding or explicitly starts a microphone test.

Permission screen copy:

> CandidCue uses your microphone only while a test or voice-tracking session is active. During voice tracking, audio is sent to OpenAI for live transcription. CandidCue does not record or save microphone audio by default.

Actions:

- Allow microphone;
- Not now;
- Open privacy details.

On macOS, include a clear microphone usage description in the application bundle. On Windows, handle both OS privacy settings and WebView permission behavior. The stage window must not request or receive microphone permission.

### 28.2 Device enumeration

Before permission, device labels may be unavailable. After permission:

- enumerate audio inputs;
- show human-readable labels;
- identify the current system default;
- remember a stable device ID where the platform permits;
- remember the chosen device's LABEL alongside its ID, and match on the label when the ID no longer resolves. WKWebView salts device IDs per origin and session and a replug can change them, so an ID-only memory silently returns the presenter to the system default — very often a headset — on some restarts. The label is what was actually chosen; re-pin the fresh ID once it matches;
- fall back to default when a saved device disappears, keep the pin, and say so, so the choice takes effect again when the device is reconnected;
- offer "follow the system default" as the first row of the input picker, naming the device it currently resolves to. It is a choice about the input device and must not be a separate control that disables and blanks the picker;
- listen for `devicechange`;
- do not switch automatically to a newly connected microphone during a live take.

During a session, changing microphone is allowed from the control window but requires an explicit confirmation: “Switching may interrupt tracking for a moment.” Preserve script position and reconnect cleanly.

### 28.3 Constraints

Initial `getUserMedia` constraints:

```ts
{
  audio: {
    deviceId: selectedId ? { exact: selectedId } : undefined,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  },
  video: false
}
```

These are defaults, not guarantees; browser engines and devices vary. Provide an Advanced toggle for echo cancellation, noise suppression, and automatic gain only if testing shows users need it. Do not expose sample-rate controls in the ordinary UI.

### 28.4 Meter and local VAD

Create an `AudioContext` and `AudioWorklet` or equivalent low-overhead analysis path for:

- RMS/peak meter;
- clipped-input detection;
- silence/no-signal detection;
- local speech/silence boundaries;
- optional ambient-noise calibration.

The analyzer must not route microphone sound to speakers. Explicitly prevent feedback.

Suggested local VAD behavior:

- adaptive noise floor from a two-second calibration window;
- speech opens after roughly 80–120 ms above threshold;
- speech remains open through short gaps;
- commit after 320–550 ms of silence, tuned through evaluation;
- force commit after a maximum active utterance of 4–6 seconds so partial/final reconciliation remains bounded;
- suppress commits for empty/noise-only buffers;
- commit immediately on soft pause, hard pause, stop, microphone switch, or detected command terminator where useful.

The exact values are evaluation parameters, not hard-coded magic numbers scattered through the codebase.

### 28.5 Microphone test

The setup test has two phases.

#### Local signal test

- 10-second live meter;
- selected device name;
- input-level guidance;
- clipping warning;
- no-signal warning;
- no network request required.

#### End-to-end transcription test

- user presses Start test;
- a Realtime transcription session opens;
- prompt says: “Say: CandidCue is following my voice.”;
- raw deltas and final transcript appear;
- readiness reports connection latency, first-text latency, and whether audio was heard;
- user can test a dictionary term and add an observed alias;
- session closes automatically after silence or Stop.

Do not mark OpenAI as ready because key validation succeeded alone. The transcription test verifies the actual path.

### 28.6 Audio failure states

Handle explicitly:

- permission denied;
- permission dismissed;
- no input devices;
- device busy or unavailable;
- device unplugged;
- track ended;
- silent input;
- clipped or extremely low input;
- WebRTC negotiation failure;
- unsupported WebView media behavior;
- OpenAI authentication failure;
- connection dropped;
- transcript events absent despite audio;
- system sleep/wake.

For each, show one primary recovery action and preserve the document position.

### 28.7 Audio retention

Default behavior:

- no microphone audio written to disk;
- no rolling audio buffer longer than needed for active transport/local analysis;
- on disconnect, clear references and close tracks/audio contexts;
- diagnostic bundles exclude audio;
- evaluation builds may record fixtures only behind a compile-time or developer-only flag with explicit consent.

---

## 29. Realtime session lifecycle

### 29.1 State machine

```text
IDLE
  → REQUESTING_PERMISSION
  → OPENING_MICROPHONE
  → MINTING_CREDENTIAL
  → NEGOTIATING
  → READY
  → LISTENING
  ↔ SOFT_PAUSED
  → RECONNECTING
  → STOPPING
  → IDLE

Any transitional or active state → ERROR_RECOVERABLE or ERROR_FATAL
```

State transitions must be centralized. Components render state; they do not each infer it from booleans.

### 29.2 Start sequence

1. Flush the current script save.
2. Compile and confirm no blocking diagnostics.
3. Load stage data and wait for stage acknowledgement.
4. Open microphone and verify an active track.
5. Mint a fresh client secret.
6. Negotiate Realtime connection.
7. Send or verify transcription configuration.
8. Start local VAD.
9. Clear old transcript buffer and initialize the alignment cursor at the selected start target.
10. Enter Ready.
11. User presses Start or says an already-supported pre-session command after explicit activation.
12. Enter Listening and begin committing speech.

Do not begin billable streaming merely because the Preflight screen opened.

### 29.3 Manual audio commit strategy

Because `gpt-realtime-whisper` uses manual commits in the current transcription session behavior, CandidCue must define commit boundaries locally.

Commit when:

- local VAD sees a speech turn followed by the configured silence;
- active speech reaches the maximum turn duration;
- the user pauses/stops;
- a command candidate needs prompt finalization;
- the microphone is about to switch or disconnect.

Maintain a local monotonically increasing `commitSequence`. When a commit is sent, record:

- local sequence;
- monotonic start/end times;
- commit reason;
- current alignment anchor;
- whether the segment is likely a command;
- current session generation.

When an OpenAI item ID becomes available, associate it with the local commit. Since completion events can arrive out of order, chronological application must use local commit order or authoritative audio ordering metadata, never arrival order alone.

### 29.4 Partial text behavior

Deltas are provisional. For each active item:

- append or reconcile deltas according to event semantics;
- normalize into provisional tokens;
- run a constrained local alignment;
- permit only modest forward movement and cue preloading;
- do not perform large backward jumps or global chapter jumps from partial text;
- visually update the control transcript without flashing wholesale replacements;
- replace the item with the completed transcript when final arrives.

### 29.5 Completion behavior

On completion:

- replace provisional transcript text for that item;
- apply available confidence/log-probability metadata;
- run full candidate generation and alignment;
- commit the resulting evidence into alignment history;
- allow strong skip or retake transitions;
- forward a completed command candidate to the command router;
- release stale per-item buffers after the rolling transcript horizon.

### 29.6 Keepalive and reconnect

Monitor:

- peer connection state;
- ICE connection state;
- data-channel state;
- last audio activity;
- last server event;
- last completed item;
- credential expiry.

Reconnect policy:

- one immediate reconnect for transient network loss;
- then exponential backoff capped at a short interval while the user remains in Live mode;
- mint a new credential for every fresh connection;
- preserve script position and stage;
- enter `PAUSED/RECONNECTING` so the stage freezes;
- buffer no more than a very small amount of local audio, and preferably do not pretend disconnected speech will be recovered;
- show “Reconnecting — position held” in the control window;
- after reconnection, prompt the user to repeat the last phrase or use a strong local search to reacquire.

Do not replay stale microphone audio across a reconnect unless the architecture explicitly guarantees privacy, chronology, and duplicate suppression.

### 29.7 Soft pause, hard pause, and stop

- **Soft pause:** keep microphone and Realtime session connected; do not advance alignment; continue listening for “CandidCue, resume” if voice commands are enabled. Audio processing and API cost continue.
- **Hard pause:** disconnect Realtime and stop microphone tracks. No voice command can resume it. Resume requires a click or keyboard shortcut and a fresh session.
- **Stop:** end the take, close transport, stop audio tracks, clear ephemeral credentials and transient transcript data, leave stage in the configured end state.

The UI must state this cost/privacy distinction directly.

### 29.8 Sleep and wake

On system suspend or long timer discontinuity:

- mark session interrupted;
- close stale peer connections;
- stop stage animations that depend on time;
- on resume, remain paused;
- require a fresh Realtime connection;
- preserve script position and settings;
- do not auto-activate the microphone without a clear user action if OS behavior changed.

---

## 30. Transcript event model and reconciliation

### 30.1 Internal event types

Convert provider events immediately into provider-neutral types:

```ts
export type TranscriptEvent =
  | { type: 'item_started'; itemId: string; commitSequence: number }
  | { type: 'delta'; itemId: string; text: string; receivedAtMs: number }
  | { type: 'completed'; itemId: string; text: string; logprobs?: TokenLogprob[] }
  | { type: 'failed'; itemId?: string; code: string; recoverable: boolean }
  | { type: 'transport_state'; state: TransportState };
```

Preserve the raw provider event only in memory for developer diagnostics, with authorization and audio fields removed.

### 30.2 Item ledger

The transcript reconciler owns an item ledger:

```ts
interface TranscriptItem {
  sessionGeneration: number;
  itemId: string;
  commitSequence: number;
  audioStartMs: number;
  audioEndMs: number;
  provisionalText: string;
  finalText?: string;
  status: 'open' | 'complete' | 'failed';
  normalizedTokens: TranscriptToken[];
  commandDisposition: 'unknown' | 'script' | 'command' | 'discarded';
}
```

The ledger provides deterministic ordering even when server completion order differs.

### 30.3 Rolling transcript horizon

Retain enough transcript context to identify retakes and resolve delayed events without unbounded growth:

- completed item text for the current session in a compact history;
- detailed token/alignment evidence for the latest 90–180 seconds;
- high-level position checkpoints for earlier content;
- optional full transcript only when the user enables session transcript retention.

Default session history is memory-only and disappears when the session ends.

### 30.4 Delta reconciliation

Do not assume every delta is a permanently append-only word boundary without verifying the provider contract. Wrap provider-specific delta handling in a strategy and test captured event streams.

The UI transcript should:

- retain stable final text;
- style only the current item as provisional;
- avoid rapid per-character stage movement;
- update at a capped rate, for example 10–15 times per second;
- never expose raw event JSON to users.

### 30.5 Confidence

Confidence signals are layered:

1. model token log probabilities, when available;
2. acoustic/session quality signals: clipping, silence, connection health;
3. lexical agreement with script candidates;
4. alignment margin between best and second-best positions;
5. continuity with prior position;
6. number and weight of rare anchors.

Never interpret one low-confidence word as evidence to jump away from a strong current path.

### 30.6 Filler handling

Maintain a configurable language-specific filler set such as:

- uh, um, erm;
- you know;
- like, when used as a filler;
- I mean;
- sort of, kind of;
- okay/so at turn starts.

Fillers remain visible in optional transcript diagnostics but carry near-zero alignment penalty. Do not globally discard words such as “like” or “so,” because they may be authored script content; classify conservatively based on context.

### 30.7 Duplicate and delayed events

- Deduplicate by session generation, item ID, event type, and content index where available.
- Ignore events from a previous connection generation.
- A completed item supersedes all deltas for that item.
- A repeated completion with identical text is harmless.
- A repeated completion with different text is recorded as a provider anomaly and the latest authoritative event is applied only according to a tested policy.
- Never move the stage backward because a delayed older item arrived after a newer one.

---

## 31. Script alignment engine

### 31.1 Product-level requirement

The aligner estimates the position the presenter is **currently attempting to read**, not merely the location of the last exact word. Its output includes:

- best token position;
- active block and sentence;
- confidence;
- state;
- evidence span;
- whether movement is provisional or final;
- detected behavior: normal read, ad-lib, skip, retake, explicit navigation, or lost;
- alternative candidates and margin;
- recommended stage target.

The aligner is deterministic, local, testable, and independent of GPT. Luna must never decide ordinary reading position.

### 31.2 Alignment states

```text
LOCKED / FOLLOWING
UNCERTAIN / HOLDING
LOST / SEARCHING
RETAKE_CANDIDATE
COMMAND_PENDING
PAUSED
RECONNECTING
```

#### LOCKED / FOLLOWING

The recent transcript strongly supports a local progression. Stage follows normally.

#### UNCERTAIN / HOLDING

Speech is occurring, but evidence is weak or looks like an ad-lib. Stage freezes or moves only minimally. The aligner continues collecting evidence.

#### LOST / SEARCHING

No credible local match has been found for a configured period or token count. Generate broader section and global candidates. Stage remains held until a high-confidence candidate wins.

#### RETAKE_CANDIDATE

A plausible earlier match exists in the current section. Require stronger evidence than forward movement before committing backward.

#### COMMAND_PENDING

The wake phrase and possible command are being finalized. Command words are masked from script alignment.

### 31.3 Candidate windows

For each transcript update, generate candidates from several scopes:

1. **Continuity window:** roughly 80 tokens behind to 260 tokens ahead of the committed cursor.
2. **Current-block retake window:** start of current paragraph through a modest distance behind.
3. **Current-section window:** all tokens in the active heading section.
4. **Recent checkpoint windows:** paragraph starts visited during the current take.
5. **Global anchor candidates:** rare tokens and high-value n-grams anywhere in the script.
6. **Explicit navigation target:** when a validated command supplies a destination.

Window sizes are tuning parameters. Scale them for sentence density and script length rather than treating the examples as universal.

### 31.4 Matching features

Score transcript token against script token using:

- exact normalized match;
- accepted dictionary alias;
- generated script alias;
- number equivalence;
- contraction equivalence;
- light edit similarity for sufficiently long tokens;
- phonetic similarity;
- proper-noun/category agreement;
- model confidence;
- local token weight;
- surrounding ordered n-gram support.

Illustrative positive scores before weighting:

| Match type | Base score |
|---|---:|
| Exact | +3.0 |
| Explicit alias | +2.8 |
| Deterministic equivalent | +2.6 |
| High lexical similarity | +1.7 |
| Phonetic similarity | +1.4 |
| Weak/common-word match | +0.5 |

Illustrative penalties:

| Condition | Penalty |
|---|---:|
| Script word skipped | -0.7 to -1.2 |
| Transcript insertion/ad-lib word | -0.3 to -0.8 |
| Strong contradiction | -1.5 |
| Disordered match | substantial |
| Backward distance | increasing prior penalty |
| Candidate far outside current section | prior penalty |

These numbers are starting hypotheses. Store them in an `AlignmentProfile` and tune against the corpus.

### 31.5 Local sequence alignment

Use a banded, weighted local sequence alignment inspired by Smith–Waterman/dynamic time warping, with constraints appropriate to speech:

- preserve token order;
- tolerate transcript insertions and script omissions;
- favor contiguous content-word runs;
- allow punctuation-free matching;
- score a rolling transcript tail, generally 8–30 meaningful tokens;
- compute matched start/end positions and normalized confidence;
- retain enough backtrace to explain anchors in diagnostics.

Do not compare the entire transcript to the entire script on every delta.

### 31.6 Continuity prior

Position probability is not uniform.

- Small forward progress is expected.
- Moderate forward skips are plausible.
- Remaining in place during ad-lib is plausible.
- A short backward restart is plausible after repetition.
- A distant backward jump is rare without explicit command.
- A global jump is plausible only with multiple distinctive anchors.

Apply a prior based on distance, section boundaries, time since last confident match, whether the previous item was final, and whether the speaker has repeated a paragraph opening.

### 31.7 Confidence calculation

Calculate confidence from:

- normalized alignment score;
- number of matched content tokens;
- weighted anchor total;
- length and continuity of matched sequence;
- score margin over the second candidate;
- distance from current cursor;
- transcript/model confidence;
- final versus provisional status.

Indicative thresholds:

- `>= 0.78` plus at least four useful content-word matches: confident local lock;
- `0.58–0.78`: soft evidence; remain or move conservatively;
- `< 0.58`: hold;
- global reacquisition: `>= 0.84`, strong margin, and at least two distinctive anchors or a longer ordered run;
- backward jump over roughly 12 tokens: `>= 0.90` and at least five useful matches, unless commanded.

Thresholds must be calibrated and can vary by movement type.

### 31.8 Provisional versus final policy

From provisional text:

- advance no more than a bounded number of tokens beyond the last final cursor;
- do not cross more than one block boundary without exceptional confidence;
- never commit a large backward jump;
- use movement primarily to reduce perceived lag.

From final text:

- commit evidence to history;
- permit forward skips;
- permit a strongly supported retake;
- enter global search when local candidates fail;
- revise a provisional overshoot smoothly.

### 31.9 Normal reading

On a normal read:

1. Match recent final and provisional tokens within the continuity window.
2. Set the semantic cursor near the latest strongly matched script token, not necessarily the final common word.
3. Predict a small visual lead based on current speaking pace and measured transcription latency.
4. Keep the active sentence in the reading band.
5. Mark passed tokens for dimming only after final confirmation or sustained evidence.

### 31.10 Ad-lib behavior

An ad-lib is transcript speech with little script agreement while the prior cursor remains credible.

- Enter UNCERTAIN after weak evidence persists beyond a short grace period.
- Freeze the stage rather than scrolling through the script.
- Continue searching locally for the return phrase.
- Ignore filler and conversational insertions cheaply.
- Return to LOCKED after a strong ordered run near or ahead of the cursor.
- Do not display “You are off script” on the stage.

### 31.11 Forward skip

A forward skip is likely when final transcript text strongly matches a later passage and there is poor support for intervening text.

Commit when:

- multiple content words match in order;
- candidate beats local alternatives by a clear margin;
- distance prior is acceptable or rare anchors are strong;
- candidate is not merely a repeated generic sentence.

Visually snap or animate to the new block using the large-jump transition. Do not scroll rapidly through every skipped line.

### 31.12 Retake and backward tracking

Detect a retake through a combination of:

- the speaker repeats the opening phrase of the current or recent sentence/paragraph;
- a strong candidate appears behind the cursor in the current section;
- the match begins near a sentence or paragraph boundary;
- the previous delivery has already passed that span;
- evidence persists across final tokens.

For a short restart inside the current paragraph, allow a lower threshold. For a previous paragraph or section, require stronger evidence.

On commit:

- move the semantic cursor backward;
- clear “passed” styling from the destination onward;
- retain a take-history marker for diagnostics;
- make a controlled stage transition, not reverse high-speed scrolling;
- do not confuse a quoted repeated phrase with a retake when later context supports forward progress.

### 31.13 Repeated passages and ambiguity

Scripts often repeat phrases such as “Let’s get started” or “The important thing is.” The aligner must not globally jump on these alone.

Use:

- surrounding n-grams;
- section prior;
- rare anchors;
- paragraph opening context;
- second-best score margin;
- sequence history.

When two candidates remain nearly tied, hold position. A manual tap or voice command resolves ambiguity.

### 31.14 Global reacquisition

Enter global search when:

- no credible local match for a configured time/token span;
- the user makes a large uncommanded jump;
- connection resumes after interruption;
- a manual “find me” action is invoked.

Procedure:

1. Query rare-token and n-gram indexes from the recent final transcript.
2. Build a bounded candidate set.
3. Align the longer recent transcript tail around each candidate.
4. Apply section/distance priors but allow them to be overcome by strong anchors.
5. Require high confidence and margin.
6. If unresolved, keep stage fixed and surface candidate buttons only in the control window.

### 31.15 Manual correction

The user can click any paragraph or search result in the control window to set the cursor. Manual correction:

- has immediate authority;
- creates a new alignment checkpoint;
- clears stale uncertain evidence;
- resets the continuity window around the target;
- suppresses automatic backward correction for a brief grace period;
- may be triggered from stage only if stage interaction is explicitly enabled.

### 31.16 Alignment snapshots

Emit at most 30 snapshots per second, usually less:

```ts
interface TrackingSnapshot {
  revision: number;
  sessionId: string;
  scriptId: string;
  tokenIndex: number;
  blockId: string;
  sentenceId: string;
  confidence: number;
  state: TrackingState;
  provisional: boolean;
  movement: 'hold' | 'advance' | 'skip' | 'retake' | 'command';
  sourceItemIds: string[];
  generatedAtMs: number;
}
```

The stage discards snapshots older than its latest revision.

### 31.17 Alignment diagnostics

Developer mode records no audio but can show:

- raw/final transcript;
- candidate positions and scores;
- winning feature breakdown;
- confidence and second-best margin;
- state transitions;
- commit boundaries;
- stage target and actual visual position.

A user diagnostic export redacts script and transcript text by default, replacing content with hashes and counts. The user can explicitly include text.

---

## 32. Coupling tracking to stage movement

### 32.1 Semantic cursor versus visual target

Keep three positions separate:

- **Committed semantic cursor:** latest position supported by final evidence.
- **Provisional semantic cursor:** low-latency estimate from partial text.
- **Visual target:** where the stage should place the active phrase after lead compensation and layout constraints.

Do not map every transcript delta directly to `scrollTop`.

### 32.2 Lead compensation

Estimate:

- speaker pace from matched tokens over recent time;
- end-to-end transcription lag from commit/audio timing to usable text;
- visual animation lag.

A small forward lead keeps the text from appearing behind the speaker. Clamp lead to a fraction of a sentence and reduce it when confidence is low. Never lead across a heading, cue, or visual-layout boundary without evidence.

### 32.3 Movement classes

#### Micro movement

Within the same rendered line or nearby lines. Use a critically damped spring or short interpolation.

#### Normal follow

Move the active sentence toward the reading band over roughly 180–350 ms, adapting to pace.

#### Large forward skip

Fade or cross-dissolve the text position over 150–250 ms, or snap with a brief focus cue. Do not visibly race through skipped text.

#### Retake/backward jump

Use a distinct but subtle 180–300 ms transition, optionally with a tiny backward arrow acknowledgement in the control window only.

#### Manual/command jump

Immediate semantic change, short visual transition, brief stage acknowledgement such as “Chapter 1” if acknowledgements are enabled.

### 32.4 Stability rules

- Ignore target changes smaller than a pixel threshold until accumulated.
- Cap stage updates to the display refresh rate.
- Do not animate while the stage is hidden or minimized.
- Precompute block top offsets after all fonts and assets load.
- If layout changes unexpectedly, freeze, recompute, and re-anchor by block/token ID.
- Avoid browser-native smooth scrolling; use a controlled transform or scroll controller with interruptible animation.
- Respect reduced motion by using near-instant jumps with no easing spectacle.

### 32.5 Reading-band geometry

Default target is 38% from the top of the safe text viewport. User range: approximately 20–70%.

The active phrase should not necessarily sit at a single pixel. Define a dead band around the target. While the phrase remains within it, avoid scrolling. This reduces constant motion and eye fatigue.

### 32.6 Fixed-speed and manual modes

The stage controller also supports:

- **Voice follow:** target comes from alignment.
- **Fixed speed:** continuous pixels-per-second or words-per-minute calibrated scroll; pause/resume; no alignment required.
- **Manual:** mouse wheel, keyboard, optional remote integrations later.

Voice commands may control all modes, but “resume” means the active mode’s behavior. Switching modes must preserve the nearest semantic position.

---

## 33. Voice command architecture

### 33.1 Core principle

Commands are a safety-sensitive control channel embedded in ordinary speech. Use deterministic parsing first, strict gating, and a small Luna fallback. Do not send every transcript segment to an LLM.

### 33.2 Default wake phrase

Default visible name and wake phrase: **CandidCue**.

Initial accepted transcript aliases after user approval:

- candid cue;
- CandidCue;
- candid Q;
- candy cue, optionally;
- other aliases learned through the setup test.

The UI should encourage the spoken pattern:

> “CandidCue, go to chapter one.”

Allow a custom wake phrase, but warn when it is a common word or appears frequently in the script.

### 33.3 Wake modes

1. **Strict wake phrase** — default. A command requires wake phrase plus command within the same or immediately adjacent committed item.
2. **Double gate** — user says “CandidCue, command, …”; maximizes collision safety.
3. **Push-to-command** — keyboard/global shortcut opens a short command window; no wake phrase required.
4. **Always command-aware** — not offered in v1 because false activations are too risky.

### 33.4 Command candidate detection

Before ordinary alignment:

1. Scan provisional/final normalized tokens for wake aliases.
2. Require a likely phrase boundary or silence around the wake term.
3. Collect following tokens until a silence, maximum command length, or recognized complete grammar.
4. Place aligner in COMMAND_PENDING.
5. Mask wake and command tokens from the ordinary spoken stream.
6. On finalization, run collision checks and deterministic parser.
7. Route unresolved but credible commands to Luna.
8. Execute only a validated `CommandAction`.
9. Resume alignment with subsequent speech.

If detection fails, release the text back to ordinary alignment.

### 33.5 Script-collision suppression

A command candidate must be rejected as a command when:

- the wake phrase and following words strongly align to the nearby script;
- the cursor is within a `literal-command` block;
- the apparent wake word has low model confidence and no clear pause;
- the phrase is part of a longer authored sentence rather than a standalone address;
- the same transcript has already been consumed as a command.

Preparation scans the script for wake aliases followed by command verbs. It offers:

- change wake phrase;
- enable double gate;
- mark the passage as literal;
- ignore warning.

### 33.6 Deterministic grammar

Implement a compact parser using normalized tokens, aliases, ordinals, numbers, heading/take indexes, and fuzzy target matching. It should resolve the majority of intended commands without a model.

Representative grammar:

```text
<wake> [please] <transport-command>
<wake> [please] go to <navigation-target>
<wake> [please] restart <relative-target>
<wake> [please] move <direction> <unit>
<wake> [please] make (the text|text) <size-change>
<wake> [please] set (the text|text) to <size-value>
<wake> [please] set margins to <margin-value>
<wake> [please] mirror [the text]
<wake> [please] turn listener <on|off>
```

Normalize polite filler without requiring exact wording.

### 33.7 Luna fallback

Use Luna only when:

- wake gating passed;
- the deterministic parser cannot confidently resolve the command;
- the text looks command-like;
- required context can be bounded;
- no local security or collision rule rejected it.

Send:

- command text without unrelated transcript;
- allowed action schema;
- current mode and position;
- nearby heading/take names;
- compact document outline;
- relevant settings bounds;
- explicit instruction to return `unknown` rather than inventing.

Do not send the entire script unless the command explicitly searches arbitrary script text and local search cannot resolve it.

### 33.8 Strict command schema

Use one strict structured output or function:

```json
{
  "name": "control_candidcue",
  "description": "Interpret a bounded teleprompter command.",
  "strict": true,
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["action", "confidence", "requires_confirmation"],
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "start", "pause", "resume", "hard_pause", "stop",
          "go_to_target", "next_section", "previous_section",
          "move_relative", "restart_unit", "set_font_size",
          "adjust_font_size", "set_margins", "toggle_mirror",
          "blank_stage", "unblank_stage", "set_listener",
          "adjust_reading_band", "set_scroll_mode", "unknown"
        ]
      },
      "target_type": {
        "type": ["string", "null"],
        "enum": ["heading", "take", "sentence", "paragraph", "beginning", "end", "phrase", null]
      },
      "target_value": { "type": ["string", "null"] },
      "direction": { "type": ["string", "null"], "enum": ["forward", "backward", "up", "down", null] },
      "amount": { "type": ["number", "null"] },
      "unit": { "type": ["string", "null"], "enum": ["sentence", "paragraph", "section", "percent", "point", null] },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
      "requires_confirmation": { "type": "boolean" }
    }
  }
}
```

Use `parallel_tool_calls: false` or equivalent. Reject responses that fail schema validation, use out-of-range values, reference nonexistent targets, or violate current-state rules.

### 33.9 Execution policy

Commands fall into safety classes.

#### Immediate

- start/resume/pause;
- next/previous section;
- back/forward sentence or paragraph;
- font/margin/read-band adjustment within bounds;
- mirror;
- Listener on/off;
- blank/unblank.

#### Confirm in control window

- stop and end session when a take is in progress, configurable;
- go to a low-confidence ambiguous duplicate target;
- reset settings;
- delete or destructive actions, though such actions should not be voice-enabled in v1.

A confirmation must not unexpectedly occupy the stage. The stage can remain held.

### 33.10 Acknowledgements

No spoken response. Feedback options:

- control-window command log: “Go to Chapter 1”;
- brief stage chip for 700–1,200 ms, off by default or subtle;
- optional quiet nonverbal sound in the control output, disabled by default to avoid entering recordings;
- error chip only in control: “I couldn’t find ‘Pricing close.’”

### 33.11 Timeouts and cancellation

- deterministic parser responds immediately;
- Luna request soft timeout: approximately 1.5 seconds, hard timeout: approximately 3 seconds, refined by tests;
- cancel a pending interpretation when session stops, a newer command supersedes it, or connection generation changes;
- do not execute a late command after the user has manually moved or changed mode unless its context revision still matches.

Every request includes `contextRevision`; every result must match the current revision before execution.

### 33.12 Command privacy

Only the detected command phrase and bounded navigation context go to Luna fallback. Ordinary transcript segments do not go to Luna. The primary transcription provider already receives the audio while tracking; the UI should distinguish that from the separate text command request.

---

## 34. Supported command catalogue

The exact phrase is flexible; the action set is finite.

### 34.1 Transport

- “CandidCue, start.”
- “CandidCue, pause.”
- “CandidCue, resume.”
- “CandidCue, hard pause.”
- “CandidCue, stop.”

Behavior note: a voice command cannot resume from hard pause because the microphone and session are closed.

### 34.2 Absolute navigation

- go to the beginning/start/top;
- go to the end/bottom;
- go to chapter/section/heading `<name>`;
- go to chapter `<number>`;
- go to take `<name>`;
- find/go to phrase `<short phrase>`.

Phrase navigation uses deterministic normalized search first. For multiple matches, prefer current/next section or show choices in control.

### 34.3 Relative navigation

- next chapter/section;
- previous chapter/section;
- back one sentence;
- forward two sentences;
- back a paragraph;
- restart this sentence;
- restart this paragraph;
- restart this section/chapter;
- restart this take;
- take me back to where I started this take.

### 34.4 Display

- make the text bigger/smaller;
- set text to `<number>` points;
- widen/narrow margins;
- set margins to `<number>` percent;
- move text higher/lower;
- mirror text;
- unmirror text;
- blank the screen;
- show the script;
- hide/show cues;

All numeric settings are clamped to safe configured ranges.

### 34.5 Listener

- turn Listener on/off;
- show/hide Listener;
- dim Listener more/less;
- switch Listener to `<installed persona name>` may be added after v1.0 if accidental visual changes are not disruptive.

### 34.6 Scroll mode

- use voice follow;
- use manual mode;
- use fixed speed;
- speed up/slow down;
- set speed to `<number>` words per minute.

### 34.7 Explicit retake marker

- “CandidCue, retake.” marks the current paragraph/take as a retake checkpoint and restarts at its configured boundary.
- “CandidCue, mark here.” creates a temporary session checkpoint, not a permanent document edit unless the user saves it after the take.

### 34.8 Unsupported requests

Do not make CandidCue feel like a general assistant. For “CandidCue, rewrite this paragraph,” “send an email,” or unrelated questions, return a compact control-window message:

> That command is not available during prompting.

---

## 35. Cost, quotas, and usage communication

### 35.1 Cost model

At the research cut-off, `gpt-realtime-whisper` is listed at approximately USD $0.017 per audio minute, or about $1.02 per hour, before taxes or later pricing changes. Luna commands and script analysis are token-priced and should be negligible in normal use compared with continuous transcription, but the app must not promise a fixed amount.

### 35.2 UI communication

Settings → OpenAI shows:

- selected transcription and command models;
- current published estimate with “Rates may change”;
- link to the official pricing page;
- session duration and estimated transcription cost for the current session;
- distinction between soft pause and hard pause;
- no claim that the app can read the user’s OpenAI bill or remaining credit unless an official endpoint supports it.

### 35.3 Cost controls

- Do not connect before user starts a test or session.
- Hard pause disconnects.
- Auto-disconnect after a configurable period of soft-pause inactivity, default perhaps 10 minutes, with warning.
- Stop the session when the control window closes unless user explicitly chooses otherwise.
- Stop orphaned sessions when stage/control relationship is lost.
- Do not run Luna for deterministic commands.
- Cache vocabulary analysis.
- Keep command context compact.
- Offer an optional per-session cost warning threshold, not required for v1.

### 35.4 Quota/rate-limit behavior

Classify and explain:

- rate limited: pause and retry after the server-indicated window;
- quota/billing exhausted: stop voice tracking and offer manual/fixed-speed modes;
- model access denied: show required model and key/project guidance;
- transient server error: reconnect conservatively;
- invalid key: return to key setup without deleting the user’s script.

Never repeatedly retry a billing error.

---

## 36. Session records and optional transcripts

### 36.1 Default record

By default, save only:

- session UUID;
- script UUID and source hash;
- start/end time;
- duration;
- mode;
- starting/ending position;
- number of retakes, commands, reconnects, and manual corrections;
- aggregate tracking quality metrics without transcript text;
- estimated cost.

This enables product diagnostics without storing what the user said.

### 36.2 Optional transcript retention

A setting may allow “Save session transcript.” When enabled:

- store finalized text only, not audio;
- mark command phrases separately;
- encrypting local transcript storage is desirable but not a substitute for OS account security;
- allow Delete immediately and automatic retention choices: 1 day, 7 days, 30 days, forever;
- expose the setting before the first retained session;
- do not silently enable it for analytics.

Transcript review/export is useful but not a core v1 screen. The storage schema can support it without making it part of launch scope.

### 36.3 Take history

Within the current live session, keep an in-memory take history:

- checkpoint position;
- start/end times;
- sections traversed;
- automatic retake transitions;
- manual retakes;
- confidence summary.

This powers “restart this take” and can be discarded at Stop.

---
# Part V — Listener mode

## 37. Listener product behavior

### 37.1 Purpose

Listener mode places a silent, dim, subtly animated person near the camera lens behind or adjacent to the teleprompter text. It is a delivery aid, not an AI character. Its job is to give the presenter a believable social focus point and reduce the feeling of speaking into an empty device.

Use the product term **Listener**, not avatar, agent, audience AI, synthetic customer, or virtual person.

### 37.2 Behavioral contract

A Listener:

- looks toward the lens or the presenter’s calibrated eye point;
- appears to listen attentively;
- makes only small, natural movements;
- never speaks;
- never lip-syncs;
- never visibly reacts to specific words;
- never displays generated text;
- never captures camera or microphone input;
- does not imply that a real person is present;
- remains visually subordinate to the script.

The user should forget that the video is looping, but should not mistake it for an interactive call.

### 37.3 Initial Listener set

Launch with three or four visually distinct, broadly useful personas. Working labels:

1. **Warm client** — approachable, attentive, gentle expressions.
2. **Focused professional** — neutral business setting, restrained nods.
3. **Curious customer** — engaged, slightly warmer responsiveness.
4. **Neutral interviewer** — calm, steady eye contact, minimal motion.

Final names should feel like presets, not fictional identities. Avoid detailed biographies. Cast should be diverse across gender, age within an adult professional range, and appearance, while maintaining consistent production quality.

### 37.4 Listener placement modes

- full background, centered behind text;
- lens-left portrait;
- lens-right portrait;
- top lens strip for compact teleprompter displays;
- picture-in-picture card;
- off.

Default for a compact lens-mounted display is centered or slightly below/around the lens, selected through calibration.

### 37.5 Visual treatment

Default treatment:

- luminance reduced substantially;
- lower saturation;
- subtle dark gradient behind text;
- optional blur, usually 0–6 px;
- soft vignette;
- text contrast checked after all effects;
- no hard-edged video rectangle unless using picture-in-picture mode.

Controls:

- opacity/dim amount;
- saturation;
- blur;
- scale;
- horizontal/vertical position;
- crop/fit mode;
- optional flip of Listener video independently from text mirror;
- freeze frame.

These controls are saved in the display profile and optionally overridden per script.

### 37.6 Script priority

The Listener must never reduce prompt readability below the theme’s contrast requirement. If a user configures an unsafe combination, show a warning and automatically add the text scrim in Live mode unless “Allow reduced contrast” is explicitly enabled in Advanced settings.

### 37.7 Session behavior

- Preload the selected Listener before the Ready state.
- Begin on a neutral frame before the take.
- Start subtle playback when the stage opens or when the user presses Start, according to preference.
- On pause, either continue listening motion or freeze; default continue on soft pause, freeze on hard pause.
- On blank stage, hide both script and Listener unless “Keep Listener when blanked” is enabled.
- If playback fails, keep the script running and show the error only in control.

---

## 38. Listener media production specification

### 38.1 Clip design

Each Listener pack contains at least three clips, approximately 12–15 seconds each. The clips should be independently loopable and mutually transitionable.

All clips for one Listener must share:

- camera position;
- lens height and focal length impression;
- crop and resolution;
- subject size;
- wardrobe;
- hair and facial details;
- background;
- lighting direction, color, and intensity;
- exposure and white balance;
- neutral opening/closing pose;
- eye-line anchor;
- no audio track.

### 38.2 Motion envelope

Allowed motion:

- natural blinking;
- slight breathing;
- tiny posture adjustments;
- small nods;
- restrained facial acknowledgement;
- occasional micro-smile;
- minimal head tilt.

Avoid:

- speaking or mouth shapes that look like words;
- large hand gestures;
- looking away for long periods;
- abrupt emotion;
- visible cuts;
- large body movement;
- changing camera perspective;
- flickering jewelry, clothing, hair, teeth, or background;
- impossible blink or eye movement;
- exaggerated “AI listener” nodding.

### 38.3 Transition frame requirement

The first and last 8–16 frames should be visually close to a shared neutral anchor. For generated video, use the same approved anchor image as start and end guidance where the generator supports it.

During post-production:

- stabilize framing;
- match color and exposure;
- remove audio;
- trim to a stable neutral boundary;
- test direct loops and every cross-clip transition;
- reject clips with identity drift or temporal artifacts;
- encode derivatives.

### 38.4 Resolution and codecs

Provide at minimum:

- 1280×720 H.264 MP4, broadly compatible;
- a WebM derivative if platform testing requires it;
- optional 1920×1080 pack for large displays;
- poster frame in WebP/PNG;
- no alpha channel required because masking and blending happen in CSS.

Use conservative profiles supported by the target macOS and Windows WebViews. Validate actual playback on supported OS versions; codec support must not be assumed from development browsers.

### 38.5 Framing and safe zones

Each pack manifest contains normalized coordinates:

- left/right eye centers;
- midpoint eye anchor;
- face bounding box;
- torso bounding box;
- recommended crop rectangle;
- recommended text exclusion zone;
- recommended lens alignment point.

The media should leave negative space for the script. Do not frame every Listener as a conventional full-screen talking head.

### 38.6 Ethical and licensing requirements

- Use adults who are licensed for this commercial use, or generation workflows whose terms permit redistribution in a commercial application.
- Keep source records, releases, generator/model terms, dates, and asset provenance.
- Do not create a recognizable public figure or imitation.
- Do not assign deceptive identities or professions.
- State in product documentation that Listener media is prerecorded or generated visual media, not a live person.
- Do not upload customer recordings into generation workflows.

---

## 39. Listener pack manifest and delivery

### 39.1 Pack manifest

Illustrative manifest:

```json
{
  "schema_version": 1,
  "pack_id": "focused-professional-01",
  "version": "1.0.0",
  "display_name": "Focused professional",
  "description": "A calm, neutral professional listener.",
  "license_id": "candidcue-owned-v1",
  "minimum_app_version": "1.0.0",
  "recommended_variant": "720p",
  "eye_anchor": { "x": 0.501, "y": 0.284 },
  "face_bounds": { "x": 0.35, "y": 0.12, "width": 0.30, "height": 0.42 },
  "clips": [
    {
      "id": "listen-a",
      "duration_ms": 14320,
      "files": [
        {
          "variant": "720p-mp4",
          "path": "listen-a-720.mp4",
          "mime": "video/mp4",
          "size_bytes": 4281741,
          "sha256": "..."
        }
      ],
      "poster": "listen-a.webp",
      "energy": "low"
    }
  ],
  "signature": "base64-ed25519-signature"
}
```

The signature should cover a canonicalized manifest excluding the signature field, including every file checksum.

### 39.2 Hosting

Host pack manifests and media on a static CDN or object store under a CandidCue-controlled origin. Requirements:

- HTTPS only;
- immutable versioned paths;
- long cache headers for versioned media;
- short cache for the catalogue;
- no executable content;
- predictable MIME headers;
- resumable downloads where practical;
- no user authentication required for included packs unless licensing/business rules later require it.

Do not embed all Listener packs in the application installer. Include, at most, one highly compressed starter pack or poster-only preview.

### 39.3 Catalogue

A signed catalogue lists:

- pack ID and latest version;
- name and thumbnail;
- approximate download size;
- available resolutions;
- minimum app version;
- availability status;
- deprecation or replacement.

The catalogue can add media but cannot change application behavior, permissions, API endpoints, or executable code.

### 39.4 Download flow

1. User chooses Download.
2. Fetch and validate catalogue/manifest.
3. Check free disk space.
4. Download to a temporary version directory.
5. Enforce file count and total size limits.
6. Verify MIME, allowed extension, size, and SHA-256.
7. Verify manifest signature with an app-embedded public key.
8. Probe video metadata and decode a sample frame.
9. Atomically rename into installed-pack directory.
10. Update database.
11. Delete temporary files on failure.

Prevent path traversal, symlink creation, nested archives, and arbitrary filenames.

### 39.5 Updates and rollback

- Keep the currently installed version until the new version verifies fully.
- Switch atomically.
- Retain the prior version until the new version has played successfully once or for seven days.
- Roll back automatically after repeated decode failure.
- User can remove downloaded packs; active session prevents removal.

### 39.6 Offline behavior

Installed packs work offline. Catalogue and download controls show “Internet connection required” when unavailable. A missing Listener never prevents manual or voice teleprompting.

---

## 40. Listener playback engine

### 40.1 Double-buffer strategy

Use two stacked video elements, A and B:

- current clip plays in A;
- next clip is loaded and decoded in B before transition;
- around the neutral transition zone, crossfade A to B over roughly 120–220 ms;
- reset A offscreen after B becomes active;
- alternate roles.

A direct same-element source swap risks a black frame or decode delay and is not acceptable for a polished stage.

### 40.2 Clip selection

Use a shuffle bag:

- play every eligible clip once before refilling;
- no immediate repeat across bag boundaries;
- optionally weight lower-energy clips more heavily;
- avoid repeating the same transition pair frequently;
- seed per session for reproducible diagnostics, not cryptographic randomness.

The first clip is selected to begin from the most neutral poster frame.

### 40.3 Transition scheduling

Prefer metadata-defined transition windows if post-production can supply them. Otherwise transition near clip end only after `canplay`/buffer readiness for the next clip.

If next clip is not ready:

- loop the current clip cleanly;
- do not show a black frame;
- retry preload;
- degrade to a poster frame after repeated errors.

### 40.4 Performance

- Decode only selected resolution.
- Pause hidden or minimized stage videos.
- Avoid multiple 1080p decoders when one Listener is visible.
- Use CSS opacity/transform rather than per-frame canvas processing.
- Measure GPU/CPU impact on low-end target systems.
- Listener playback may reduce from 60 to 30 fps without affecting script movement, but stage text must remain smooth.

### 40.5 Failure containment

Listener errors are nonfatal. The engine emits:

- pack unavailable;
- checksum/signature failure;
- unsupported codec;
- decode failure;
- insufficient disk;
- download interrupted;
- manifest incompatible.

The control window offers Retry, Use poster, Choose another, or Turn off. The stage silently falls back to the text-only theme.

---

## 41. Listener and camera-lens calibration

### 41.1 Calibration model

A display profile stores Listener geometry in normalized stage coordinates so it survives resolution changes:

```ts
interface ListenerGeometry {
  anchorX: number;
  anchorY: number;
  scale: number;
  cropX: number;
  cropY: number;
  cropZoom: number;
  opacity: number;
  blurPx: number;
  saturation: number;
  mirrorVideo: boolean;
}
```

Store text safe area and reading band separately.

### 41.2 Calibration wizard

1. Open stage on chosen display.
2. Show a high-contrast target crosshair.
3. User drags the target to the physical camera lens location as seen through the teleprompter.
4. Show Listener poster and eye marker.
5. User aligns the Listener’s selected eye or eye midpoint with the crosshair.
6. User adjusts scale and crop.
7. Overlay sample teleprompter text.
8. User adjusts opacity and safe area.
9. Save as named display profile.

Provide keyboard nudging at one-pixel and ten-pixel steps. Show a Reset button and numeric fields in Advanced.

### 41.3 Lens-target presets

Provide presets only as starting points:

- centered lens;
- lens above display center;
- Elgato-style compact landscape display;
- side-mounted camera.

Do not claim exact physical calibration for a hardware model without testing that model.

### 41.4 Stage resize

On display resolution or scale-factor change:

- recompute normalized geometry;
- preserve the lens anchor;
- recompute text safe area;
- freeze tracking for one layout frame;
- return the active token to the reading band;
- save updated physical display fingerprint only after stability.

---
# Part VI — Application architecture

## 42. Technology stack and architectural shape

### 42.1 Required stack

Use:

- **Tauri 2** for native application lifecycle, windows, security capabilities, packaging, and updates;
- **Rust** for trusted operations, persistence, filesystem access, secret handling, OpenAI REST calls, Listener downloads, and application coordination;
- **Svelte 5 + TypeScript + Vite** for the control and stage interfaces;
- **CodeMirror 6** for Markdown editing;
- **unified/remark/rehype** or an equivalently tested AST pipeline for Markdown compilation and sanitization;
- **SQLite** through Rust, preferably `sqlx`, for metadata and indexes;
- **WebRTC** in the control webview for the primary Realtime transcription transport;
- **Web Workers** for Markdown compilation and script alignment, keeping high-frequency work off the UI thread;
- **pnpm** for JavaScript package management;
- the current stable Rust toolchain pinned through `rust-toolchain.toml`;
- lockfiles committed for both ecosystems.

Pin compatible production versions at implementation time rather than copying version numbers from this document. Tauri core and plugin versions should remain aligned.

### 42.2 Deliberately excluded stack choices

Do not add by default:

- SvelteKit server/runtime features;
- Electron compatibility layers;
- a Node sidecar;
- a local HTTP server;
- Redux or another large state framework;
- an ORM exposed to the frontend;
- browser local storage as canonical persistence;
- a shell plugin;
- arbitrary remote web content;
- a general agent framework;
- React merely because libraries assume it;
- a separate backend service.

Use a simple Svelte SPA with explicit route/state machines. Add dependencies only when they replace meaningful, tested work.

### 42.3 System diagram

```text
┌──────────────────────────────── CandidCue process ────────────────────────────────┐
│                                                                                   │
│  ┌──────────────── Control WebView ───────────────┐                                │
│  │ Svelte UI                                      │                                │
│  │ CodeMirror editor                              │                                │
│  │ WebRTC microphone + Realtime data channel      │                                │
│  │ Transcript reconciler                          │                                │
│  │ Compiler Web Worker                            │                                │
│  │ Tracking Web Worker                            │                                │
│  │ Command parser                                 │                                │
│  └───────────────┬───────────────────────┬────────┘                                │
│                  │ typed Tauri IPC       │ validated stage snapshots              │
│                  ▼                       ▼                                         │
│  ┌──────────────────────────── Rust core / coordinator ─────────────────────────┐  │
│  │ Script repository        SQLite              Window/display coordinator       │  │
│  │ Files/assets/revisions   SecretStore         OpenAI REST client               │  │
│  │ Listener catalogue       Download verifier   Updater and diagnostics          │  │
│  │ Session metadata         Typed event bridge  Application lifecycle            │  │
│  └───────────────┬───────────────────────┬───────────────────────────────────────┘  │
│                  │                       │                                          │
│                  │ minimal stage events  │ HTTPS                                    │
│                  ▼                       ▼                                          │
│  ┌──────────────── Stage WebView ────────┐       OpenAI API / CandidCue CDN         │
│  │ Read-only compiled stage document     │                                          │
│  │ Controlled text-motion renderer       │                                          │
│  │ Listener video playback               │                                          │
│  │ No key, microphone, database, or REST │                                          │
│  └───────────────────────────────────────┘                                          │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 42.4 Responsibility rule

Place code according to trust and frequency:

- secret, filesystem, database, download, update, and privileged OS operations: Rust;
- high-frequency browser media and WebRTC operations: control webview;
- deterministic CPU-heavy text work: Web Worker;
- visual animation: stage webview;
- cross-window authority and lifecycle: Rust coordinator.

Do not move privileged work into JavaScript for convenience, and do not route per-audio-frame data through Tauri IPC.

### 42.5 Repository organization

Recommended monorepo:

```text
candidcue/
  package.json
  pnpm-lock.yaml
  vite.config.ts
  tsconfig.json
  rust-toolchain.toml
  src/
    control/
      main.ts
      App.svelte
      routes/
      components/
      stores/
      services/
    stage/
      main.ts
      StageApp.svelte
      renderer/
      listener/
    shared/
      contracts/
      design/
      markdown/
      commands/
      tracking/
      utilities/
    workers/
      compiler.worker.ts
      tracking.worker.ts
    styles/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/
      control.json
      stage.json
    icons/
    migrations/
    src/
      main.rs
      app.rs
      commands/
      coordinator/
      database/
      scripts/
      assets/
      secrets/
      openai/
      listeners/
      windows/
      updates/
      diagnostics/
      errors.rs
  tests/
    fixtures/
      markdown/
      transcript-events/
      alignment/
      audio/
    unit/
    integration/
    e2e/
  scripts/
    build-listener-manifest/
    generate-test-corpus/
  docs/
    architecture-decisions/
    privacy/
    release/
```

Use architectural-decision records for consequential changes such as replacing WebRTC transport, moving the aligner to Rust, or enabling raw SVG.

---

## 43. Window and process model

### 43.1 Control window

Label: `control`.

The control window owns:

- onboarding;
- script library and editor;
- settings;
- preparation and diagnostics;
- microphone and WebRTC;
- tracking worker;
- command parsing;
- Live controls;
- operational errors.

Default size should be suitable for a laptop display, with a reasonable minimum. Restore its last safe bounds. If saved bounds are offscreen after monitor changes, center it on the primary display.

### 43.2 Stage window

Label: `stage`.

The stage window owns only:

- current compiled visual document;
- stage theme and layout;
- text motion;
- cue display;
- Listener playback;
- blank/freeze states;
- brief visual acknowledgements.

It is read-only and must work from a session snapshot already supplied by control/Rust. It cannot load arbitrary files, save settings, invoke OpenAI, enumerate microphones, or manage updates.

### 43.3 Stage creation

Create the stage lazily when first needed or hidden at application startup if that produces more reliable monitor behavior. Required sequence:

1. determine target display from profile or selection;
2. create stage with `visible: false`;
3. position and size to display bounds;
4. load the stage entry point;
5. perform stage handshake;
6. send initial theme/document/assets;
7. wait for fonts and media readiness;
8. enter fullscreen or borderless display mode;
9. show without an intermediate flash.

On macOS, prefer the fullscreen mode that does not create a separate Space when it meets the tested teleprompter workflow. On other platforms use normal fullscreen/borderless behavior. Always retain a keyboard escape and control-window exit.

### 43.4 Multi-window authority

The Rust `AppCoordinator` knows:

- whether stage exists;
- stage readiness generation;
- selected display fingerprint;
- active session ID;
- active script and compile hash;
- control/stage heartbeat;
- whether app quit is in progress.

The control window requests actions; it does not assume window creation succeeded. The stage acknowledges document load and rendered layout before the control marks Preflight ready.

### 43.5 Stage heartbeat

During a live session:

- control sends a small heartbeat or state revision periodically;
- stage acknowledges current session/revision;
- if control disappears, stage freezes and exits after a short grace period or according to user preference;
- if stage disappears, control enters recoverable error, keeps position, and offers Reopen stage;
- stale snapshots from a previous stage generation are ignored.

### 43.6 Application close behavior

Closing control while Live:

- show a native/control confirmation unless “Stop immediately on close” is selected;
- on confirmation, stop microphone and Realtime session first;
- close stage;
- flush session metadata and saves;
- clear ephemeral state;
- exit.

Closing stage alone stops presentation but does not delete the script. The control window remains open and offers reopen.

### 43.7 Single-instance behavior

Use a single-instance mechanism if supported and tested. A second launch should focus the existing control window and forward a valid imported file path. Validate paths and accepted extensions in Rust. Do not create two processes competing for the same SQLite database and stage display.

### 43.8 Window persistence

Persist:

- control size/position/maximized state;
- last stage display profile, not blindly its raw coordinates;
- stage layout profile;
- never persist stage as automatically visible/fullscreen on normal app launch.

Restore control bounds only after validating they intersect an available display.

---

## 44. Rust core modules

### 44.1 `app`

- Tauri builder and plugin registration;
- application startup/shutdown;
- dependency construction;
- migration execution;
- command registration;
- global state initialization;
- panic/error hooks with redaction.

### 44.2 `coordinator`

A single actor or mutex-protected service for cross-subsystem state:

- active session lifecycle;
- window generations;
- current script/save revision;
- stage handshake;
- cancellation tokens;
- graceful shutdown;
- stale-request rejection.

Avoid one global mutable struct containing every subsystem. Use typed services and explicit coordination.

### 44.3 `database`

- SQLite connection pool sized appropriately for a desktop app;
- migrations;
- WAL mode;
- foreign keys enabled;
- busy timeout;
- typed repositories;
- transaction helpers;
- corruption detection and recovery guidance;
- scheduled checkpoint/backup.

### 44.4 `scripts`

- script CRUD;
- atomic canonical file writes;
- external-change detection;
- revisions;
- import/export;
- metadata updates;
- trash and restoration;
- word/timing statistics persistence;
- compiled-cache metadata.

### 44.5 `assets`

- validated image import;
- MIME sniffing;
- hash/deduplication;
- derivative generation if implemented;
- scoped asset URL creation;
- garbage collection;
- bundle safety.

### 44.6 `secrets`

Expose a narrow interface:

```rust
#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn set_openai_key(&self, key: SecretString) -> Result<()>;
    async fn get_openai_key(&self) -> Result<Option<SecretString>>;
    async fn delete_openai_key(&self) -> Result<()>;
    async fn describe_openai_key(&self) -> Result<Option<RedactedSecretMetadata>>;
}
```

Use native OS credential storage through a maintained Rust library. Ensure `SecretString` redacts `Debug`/`Display` output. Zero or drop temporary buffers where practical. If secure persistent storage is unavailable, offer session-only key storage rather than plaintext fallback.

### 44.7 `openai`

- authenticated REST client;
- key validation;
- client-secret creation;
- Luna structured request;
- vocabulary analysis;
- typed provider errors;
- retry/backoff policy;
- usage extraction where returned;
- endpoint/model capability definitions;
- test mock server adapter.

### 44.8 `listeners`

- catalogue retrieval;
- signature verification;
- safe download;
- checksums;
- disk capacity;
- media probing;
- installation/rollback/removal;
- installed-pack queries;
- asset URLs scoped to installed media.

### 44.9 `windows`

- display enumeration and fingerprinting;
- safe window positioning;
- stage creation/destruction;
- fullscreen behavior;
- focus and cursor behavior;
- window-state recovery;
- control-to-stage event bridge.

### 44.10 `updates`

- update checks;
- signed updater integration;
- release channel;
- download/install coordination;
- never install during Live;
- rollback/relaunch messaging where supported.

### 44.11 `diagnostics`

- structured logs with redaction;
- rolling log retention;
- system/application version;
- WebView and display facts;
- database integrity result;
- media codec test result;
- exportable support bundle;
- no API key, audio, script, or transcript by default.

### 44.12 Error model

All Rust errors exposed through IPC map to a stable application error:

```ts
interface AppError {
  code: string;
  category: 'validation' | 'permission' | 'network' | 'auth' |
    'quota' | 'storage' | 'database' | 'media' | 'window' |
    'provider' | 'internal';
  userMessage: string;
  recoverable: boolean;
  action?: 'retry' | 'open_settings' | 'choose_device' | 'reconnect' |
    'reveal_folder' | 'use_manual_mode' | 'contact_support';
  correlationId: string;
  details?: Record<string, string | number | boolean>;
}
```

Never expose a raw Rust debug string or provider response body as user-facing copy.

---

## 45. Frontend architecture

### 45.1 Control application routes

Use a lightweight in-app router or explicit route store:

```text
/onboarding
/library
/script/:id/edit
/script/:id/revisions
/script/:id/preflight
/live/:sessionId
/settings/:section
/trash
/about
```

Navigation must guard unsaved conflict states and active sessions.

### 45.2 State domains

Separate stores/services:

- `AppStatusStore` — startup/migration/update facts;
- `ScriptLibraryStore` — summaries and search;
- `EditorStore` — current source, save revision, diagnostics;
- `CompiledScriptStore` — immutable compile result/hash;
- `PreflightStore` — readiness checks;
- `AudioStore` — devices, permission, meter;
- `RealtimeStore` — transport/session status;
- `TrackingStore` — latest snapshots and diagnostics;
- `CommandStore` — wake settings, pending/recent command;
- `StageStore` — display, stage generation, theme/layout;
- `ListenerStore` — catalogue/installed/playback selection;
- `SettingsStore` — validated settings view;
- `NotificationStore` — control-only notices.

Do not create a single omniscient store.

### 45.3 Compiler worker

The compiler worker receives:

- source text;
- script ID;
- compile settings;
- dictionary snapshot;
- requested operation: incremental/full.

It returns versioned immutable results. The UI tags every request with `editorRevision`; results from older revisions are discarded.

### 45.4 Tracking worker

The tracking worker owns:

- compiled spoken tokens/indexes;
- transcript ledger projection;
- alignment profile;
- cursor/state/history;
- candidate scoring;
- retake/skip logic;
- tracking metrics.

Messages:

```ts
// inbound
{ type: 'initialize'; compiled: TrackingDocument; profile: AlignmentProfile }
{ type: 'transcript_event'; event: ReconciledTranscriptUpdate }
{ type: 'manual_move'; target: NavigationTarget; revision: number }
{ type: 'command_move'; target: NavigationTarget; revision: number }
{ type: 'pause' | 'resume' | 'reset' }

// outbound
{ type: 'snapshot'; snapshot: TrackingSnapshot }
{ type: 'state_change'; state: TrackingState }
{ type: 'diagnostic'; diagnostic: AlignmentDiagnostic }
```

Use transferable typed arrays for large token/index data if profiling justifies it. Do not serialize the full document on every event.

### 45.5 Command service

Runs in control frontend because it consumes transcript updates and local outline/indexes. It contains:

- wake detector;
- collision gate;
- deterministic parser;
- command validator;
- context revision manager;
- Rust invocation for Luna fallback;
- action executor;
- command history.

No Svelte component contains command parsing logic.

### 45.6 Stage application

The stage is a separate Vite entry point or an unambiguously isolated route bundled without control-only code. Its state is small:

- stage session envelope;
- compiled render model;
- current tracking snapshot;
- layout/theme;
- Listener geometry/playback;
- acknowledgement/blank state;
- stage health.

Stage rendering should not require the Markdown parser during a live session if the control has already supplied a compiled render model. The stage may hydrate a safe serialized structure into known Svelte components; it must not accept arbitrary HTML without revalidation.

### 45.7 Design system package

Create tokens and reusable primitives:

- typography;
- spacing;
- radii;
- border and surface colors;
- icon sizes;
- focus styles;
- buttons, fields, tabs, segmented controls, cards, status pills;
- menu and dialog behavior;
- empty/error states;
- stage themes separately from control themes.

The old Electron prototype can inform these values, but implementation should converge them into a coherent token system rather than copying component CSS verbatim.

### 45.8 Type validation

Generate or manually maintain mirrored Rust/TypeScript contracts. Validate IPC responses and downloaded JSON at runtime with Zod or a similarly small schema library. TypeScript compile-time types alone do not protect runtime boundaries.

---

## 46. IPC contract

### 46.1 Principles

- Every command has a typed request and response.
- Commands are coarse-grained; avoid chatty filesystem/database calls.
- Privileged arguments are validated in Rust.
- Requests carry relevant revision/session IDs.
- Long operations support cancellation or are detached into managed jobs with progress events.
- Stage receives the minimum data it needs.
- Do not expose generic “read any file,” “write any file,” “HTTP request,” or “execute” commands.

### 46.2 Script commands

```text
list_scripts(filter, sort, page) -> ScriptPage
create_script(input) -> ScriptRecord
get_script(script_id) -> ScriptDocument
save_script(script_id, expected_revision, source, metadata_patch) -> SaveResult
rename_script(script_id, title, expected_revision) -> ScriptRecord
duplicate_script(script_id) -> ScriptRecord
trash_script(script_id) -> void
restore_script(script_id) -> ScriptRecord
permanently_delete_script(script_id) -> void
list_revisions(script_id) -> RevisionSummary[]
get_revision(script_id, revision_id) -> RevisionDocument
restore_revision(script_id, revision_id, expected_revision) -> SaveResult
import_script(options) -> ImportResult
export_script(script_id, options) -> ExportResult
reveal_script_folder(script_id) -> void
```

### 46.3 Asset commands

```text
import_image(script_id, source_file) -> ImportedAsset
import_remote_image(script_id, url) -> ImportedAsset
resolve_asset_urls(script_id, asset_ids[]) -> AssetUrlMap
remove_asset_reference(script_id, asset_id) -> void
```

File pickers return opaque paths/tokens to Rust where possible; never trust a frontend-created arbitrary destination path.

### 46.4 Secret/OpenAI commands

```text
validate_openai_key(candidate_key) -> KeyValidationResult
save_openai_key(candidate_key) -> RedactedKeyMetadata
get_openai_key_status() -> OpenAiKeyStatus
delete_openai_key() -> void
create_realtime_transcription_credential(config) -> EphemeralCredential
interpret_command(request) -> CommandInterpretation
analyze_vocabulary(request) -> VocabularyAnalysisResult
```

`validate_openai_key` necessarily receives the candidate from the control window once. Ensure the input is never copied into store history or logs. After save, purge the field and component state.

### 46.5 Microphone ownership

Ordinary microphone enumeration and WebRTC happen in control JavaScript. Rust commands may expose platform diagnostics or privacy-settings helpers but should not duplicate capture unless native WebSocket fallback is activated.

### 46.6 Stage/window commands

```text
list_displays() -> DisplayDescriptor[]
identify_displays() -> IdentificationSession
open_stage(request) -> StageOpenResult
close_stage(session_id) -> void
set_stage_fullscreen(session_id, enabled) -> StageWindowState
publish_stage_document(session_id, document_envelope) -> StageAck
publish_stage_snapshot(session_id, snapshot) -> void
publish_stage_command(session_id, action) -> void
get_stage_status(session_id) -> StageStatus
save_display_profile(profile) -> DisplayProfile
```

`publish_stage_snapshot` validates numeric bounds, identifiers, session generation, and payload size before emitting to stage.

### 46.7 Listener commands

```text
get_listener_catalogue(force_refresh) -> ListenerCatalogue
list_installed_listeners() -> InstalledListener[]
download_listener(pack_id, variant) -> DownloadJob
cancel_listener_download(job_id) -> void
remove_listener(pack_id, version) -> void
resolve_listener_media(pack_id, version) -> ListenerMediaUrls
```

Progress events include bytes and phase without filesystem paths that the stage does not need.

### 46.8 Settings and diagnostics

```text
get_settings() -> AppSettings
update_settings(expected_revision, patch) -> AppSettings
export_all_data(destination) -> ExportResult
clear_cache(kind) -> ClearResult
get_system_diagnostics() -> SystemDiagnostics
export_support_bundle(options) -> ExportResult
check_for_update() -> UpdateCheckResult
install_update() -> void
```

### 46.9 Events

Rust → control:

- `script://external-change`;
- `stage://ready`, `stage://closed`, `stage://error`;
- `listener://download-progress`;
- `listener://catalogue-updated`;
- `update://available`, `update://progress`;
- `app://device-or-display-change`;
- `diagnostic://warning`.

Rust → stage:

- `stage://load-session`;
- `stage://tracking-snapshot`;
- `stage://apply-command`;
- `stage://listener-state`;
- `stage://close-session`.

Stage → Rust/control:

- `stage://hydrated`;
- `stage://layout-ready`;
- `stage://heartbeat`;
- `stage://media-error`;
- `stage://escape-requested`.

Use namespaced events and version payloads. Emit stage payloads directly to the `stage` window label rather than broadcasting them across the application. Never place secrets, raw provider events, filesystem paths, or unrestricted control-state objects on the shared event bus.

### 46.10 Payload limits

- command text: small bounded strings;
- full Markdown: bounded by supported script size, perhaps 5–10 MB with warnings far earlier;
- stage document: compressed/compact and bounded;
- images/videos never pass through JSON/base64 IPC;
- diagnostics arrays capped;
- downloadable manifests capped before parsing.

---

## 47. Persistence and filesystem architecture

### 47.1 Data directory

```text
<CandidCue app data>/
  candidcue.sqlite3
  candidcue.sqlite3-wal
  candidcue.sqlite3-shm
  scripts/
    <script-uuid>/
      script.md
      assets/
        <sha256>.<ext>
      revisions/
        <timestamp>-<hash>.md
  listeners/
    <pack-id>/
      <version>/
        manifest.json
        *.mp4
        *.webm
        *.webp
  cache/
    compiled/
      <source-hash>-<settings-hash>.json
    vocabulary/
    thumbnails/
    downloads/
  backups/
  logs/
    candidcue.log
  diagnostics/
```

The OpenAI key is not stored in this directory.

### 47.2 SQLite responsibilities

SQLite stores discoverable/queryable metadata, not opaque copies of every large asset. Core table groups:

- scripts;
- script revisions;
- script assets and references;
- compile/analysis cache metadata;
- dictionary entries;
- display profiles;
- installed Listener packs;
- application settings;
- sessions and optional transcript items;
- migration/application metadata.

### 47.3 Database settings

At connection startup:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

Revisit synchronous mode for critical writes and platform behavior. Use transactions for multi-table changes.

### 47.4 Migration policy

- monotonically numbered embedded migrations;
- database backup before destructive migration;
- migration transaction where SQLite permits;
- fail closed with recovery copy if migration fails;
- application never opens a newer unsupported schema for write;
- migrations tested from every previously shipped schema version.

### 47.5 Canonical-file/database consistency

Save transaction protocol:

1. acquire per-script write lock;
2. verify expected revision and external file fingerprint;
3. write temporary Markdown;
4. flush/rename canonical file;
5. open SQLite transaction;
6. update script source hash, metadata, revision, timestamps;
7. insert revision metadata if created;
8. commit;
9. update in-memory cache.

If step 5–8 fails after the file write, startup reconciliation compares file hashes and repairs metadata. The Markdown must remain recoverable.

### 47.6 Startup reconciliation

At startup or after an unclean exit:

- run quick database integrity checks;
- remove abandoned temporary files older than a safe threshold;
- detect canonical files missing from database and offer recovery/import;
- detect database script rows with missing files and restore from latest revision if possible;
- finish or roll back Listener installs;
- clear expired compiled caches;
- preserve evidence in a recovery report instead of deleting uncertain data.

### 47.7 Backups

- create a SQLite online backup periodically and before migrations;
- retain several rotating backups;
- canonical script revisions provide additional document recovery;
- expose Export all data;
- never claim cloud backup.

### 47.8 Asset URLs

Expose local images and Listener media through Tauri’s scoped asset protocol or a custom protocol with strict allowlists. Do not give the stage unrestricted filesystem read access.

Allowed roots:

- active script asset directory;
- active installed Listener directory;
- bundled app resources.

Validate resolved paths after canonicalization and reject symlinks escaping roots.

### 47.9 Settings storage

Store ordinary settings in SQLite or one versioned JSON/settings table through Rust. Do not split settings unpredictably across browser storage and files.

Settings types:

- global application;
- display profile;
- tracking profile;
- per-script override;
- session-only temporary.

Resolution order:

```text
session override → script override → selected profile → global default
```

Expose the effective value and reset behavior clearly.

---
## 48. State ownership, concurrency, and recovery

### 48.1 Source-of-truth matrix

| State | Authority | Replicas |
|---|---|---|
| Saved OpenAI permanent key | OS credential store via Rust | transient Rust secret only; one-shot control input exists only during initial entry/replacement |
| Canonical script source | managed Markdown file | editor buffer, revision files |
| Script metadata | SQLite | control stores |
| Compiled script | compiler output keyed by source/settings hash | control, stage-safe projection, cache |
| Current transcript | control transcript reconciler | tracking worker projection |
| Tracking cursor | tracking worker | control view, stage snapshot |
| Active session lifecycle | Rust coordinator | control/stage views |
| Stage visual position | stage renderer | latest semantic target in control |
| Display profiles | SQLite/Rust | control/stage effective snapshot |
| Listener media | verified filesystem install | stage playback URLs |
| App settings | SQLite/Rust | control effective settings |

A replica must never silently overwrite its authority.

### 48.2 Revision identifiers

Use independent monotonically increasing revisions:

- `scriptRevision` — canonical authored source/metadata;
- `compileRevision` — compiler result for a specific editor revision;
- `sessionGeneration` — active session/reconnect generation;
- `trackingRevision` — tracking worker snapshot;
- `stageGeneration` — stage window incarnation;
- `settingsRevision` — persisted settings;
- `commandContextRevision` — state against which a command was interpreted.

Every asynchronous result carries the revisions it depends upon. Discard stale results instead of attempting ad hoc merging.

### 48.3 Cancellation

Use cancellation tokens for:

- key validation;
- client-secret creation if session start is abandoned;
- vocabulary analysis;
- Listener downloads;
- import/export;
- stage creation;
- update download;
- Luna command requests.

Stopping a live session cancels all session-scoped operations.

### 48.4 Per-script locking

Only one canonical save operation per script runs at a time. Autosave coalesces pending changes to the newest revision. Import/export and revision restoration acquire compatible read/write locks.

### 48.5 Crash recovery

On unclean exit:

- recover autosaved canonical source, not unsaved in-memory text that never reached disk;
- show “CandidCue closed unexpectedly” only when confirmed;
- run reconciliation before opening the last script;
- do not auto-reopen a stage or microphone;
- restore control window safely;
- offer diagnostic bundle after repeated crashes;
- retain logs within privacy constraints.

### 48.6 Database corruption

If integrity checks fail:

1. close writes;
2. make a byte-for-byte copy of affected database;
3. attempt restore from latest known-good backup;
4. scan managed script directories and rebuild a fresh index where possible;
5. preserve dictionary/display settings from recoverable records;
6. explain exactly what was restored and what may be missing.

Canonical Markdown is the key recovery mechanism.

### 48.7 Network degradation

The app should degrade in layers:

- Luna unavailable: deterministic commands and cached vocabulary continue;
- Realtime unavailable: manual/fixed-speed prompting continues;
- Listener CDN unavailable: installed packs continue;
- updater unavailable: app continues;
- all network unavailable: local documents, editor, preview, manual/fixed stage continue.

### 48.8 Long-session behavior

Test continuous sessions of at least two hours. Bound:

- transcript item history;
- alignment diagnostic history;
- stage event queues;
- video elements/decoders;
- object URLs;
- log volume;
- reconnect attempts.

A long session must not grow memory linearly without a defined ceiling.

---

## 49. Tauri capabilities, permissions, and content security policy

### 49.1 Capability philosophy

Tauri capabilities must be defined separately for control and stage. A window assigned to multiple capabilities effectively accumulates their permissions, so avoid broad shared capability files.

The control window receives only the application commands and core APIs it uses. The stage window receives event listening, limited window operations, and scoped local media access. It does not receive script-storage, secret, OpenAI, filesystem, updater, dialog, shell, or global-shortcut capabilities.

### 49.2 Control capability outline

Illustrative—not copy-paste complete:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "control-capability",
  "description": "Permissions for the CandidCue control window",
  "windows": ["control"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "window-state:default",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister"
  ]
}
```

Custom Rust commands still validate all input. Do not add broad filesystem permissions merely because a plugin is installed.

### 49.3 Stage capability outline

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "stage-capability",
  "description": "Minimal permissions for the read-only teleprompter stage",
  "windows": ["stage"],
  "permissions": [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:window:allow-set-fullscreen",
    "core:window:allow-set-focus"
  ]
}
```

Prefer Rust-owned stage fullscreen/focus calls if that permits removing even these operations.

### 49.4 Plugins

Expected official plugins, subject to implementation need:

- dialog;
- window-state;
- updater;
- process for updater relaunch only;
- global-shortcut, optional and off by default;
- single-instance, if selected;
- opener only for tightly validated external URLs, or use a custom Rust command.

Avoid:

- shell;
- unrestricted filesystem frontend API;
- arbitrary HTTP frontend plugin;
- clipboard read permissions beyond explicit paste behavior;
- deep links until a real use case exists.

### 49.5 Content security policy

Start from a strict CSP and loosen only after testing. Conceptual policy:

```text
default-src 'self' customprotocol: asset:;
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' asset: blob: data:;
media-src 'self' asset: blob:;
font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost https://api.openai.com;
worker-src 'self' blob:;
object-src 'none';
frame-src 'none';
base-uri 'none';
form-action 'none';
```

The exact Tauri-generated source schemes differ by platform/configuration. Validate the production build. Avoid `unsafe-eval`. Inline style may be required by Svelte/runtime layout; use nonces/hashes or generated CSP support where practical.

Listener catalogue and media downloads should occur in Rust, so the webview does not need CDN origins in `connect-src` or `media-src`.

### 49.6 Asset protocol scope

Enable only if required. Scope it to app-managed script assets, installed Listener packs, and bundled resources. The frontend must request opaque asset IDs or validated URLs from Rust rather than converting arbitrary user paths itself.

### 49.7 Navigation protection

- Stage and control may navigate only to bundled application content.
- Intercept `window.open`, dropped URLs, and link clicks.
- Open approved `https` links in the system browser after validation and user action.
- Reject `javascript:`, `data:` navigation, local file navigation, unknown schemes, and embedded remote pages.
- Markdown links never navigate the stage during Live mode.

### 49.8 Developer tooling

Disable devtools in production unless a documented support mode is intentionally enabled. Ensure production errors do not reveal source maps or secrets. Keep source maps private or upload only to a chosen crash service with opt-in and a privacy review.

---

## 50. Security, privacy, and threat model

### 50.1 Assets to protect

- permanent OpenAI key;
- script text and imported visuals;
- microphone audio in flight;
- optional transcript text;
- local file paths and user identity clues;
- signed update and Listener integrity keys;
- ability to control the stage during a recording;
- application update channel.

### 50.2 Trust zones

1. Rust process and native credential store — trusted application core.
2. Bundled control webview — trusted but exposed to rendered user content and web technologies.
3. Bundled stage webview — minimal, read-only presentation surface.
4. OpenAI API — external processor chosen by BYOK user.
5. CandidCue static CDN/update host — external content distribution.
6. User-authored/imported Markdown and assets — untrusted input.
7. Downloaded Listener packages — untrusted until verified.
8. Operating system/device — assumed user-controlled but potentially shared or compromised.

### 50.3 Threat: malicious Markdown steals key or invokes privileged commands

Controls:

- raw HTML disabled;
- sanitizing AST pipeline;
- no arbitrary scripts/iframes/styles;
- saved permanent key is never returned to JavaScript; the one-shot entry field is cleared immediately after submission;
- narrow Tauri command surface;
- command input validation in Rust;
- strict CSP;
- local/remote asset restrictions;
- tests with XSS payload corpus.

### 50.4 Threat: key leaks through logs, crashes, or UI

Controls:

- secret wrapper with redacted formatting;
- authorization headers explicitly excluded from tracing;
- request/response body logging off;
- API key field cleared after save;
- redacted suffix only;
- crash context scrubber;
- support bundle secret scanner;
- automated test that injects a fake key and verifies it is absent from filesystem/logs/snapshots.

### 50.5 Threat: key exposure in WebRTC browser flow

Controls:

- Rust mints a short-lived client secret;
- permanent key never crosses IPC after initial user entry/save;
- ephemeral token remains in memory only;
- token is scoped to a transcription session;
- clear token after connect/disconnect;
- stage has no token;
- do not persist network debugging traces in production.

### 50.6 Threat: malicious Listener pack

Controls:

- CandidCue-controlled HTTPS origin;
- signed canonical manifest;
- checksums for all files;
- extension/MIME allowlist;
- no archives inside packs;
- path and size limits;
- media probe in isolated normal decoder path;
- no HTML/JS/content documents;
- atomic install;
- rollback;
- catalogue cannot grant permissions.

### 50.7 Threat: path traversal or arbitrary file access

Controls:

- UUID/hash-controlled managed paths;
- canonicalize and validate under allowed root;
- reject parent components and absolute bundle paths;
- no generic frontend filesystem API;
- safe archive extraction rules;
- symlink rejection;
- fuzz import and manifest paths.

### 50.8 Threat: compromised update channel

Controls:

- Tauri updater signatures are mandatory;
- keep updater private key outside repository and ordinary CI logs;
- use least-privilege release secrets;
- signed/notarized platform artifacts;
- HTTPS manifests;
- two-person or explicit release approval where practical;
- publish checksums;
- update never executes during Live mode;
- recovery plan for key loss or compromise documented before launch.

### 50.9 Threat: false voice command disrupts a take

Controls:

- wake phrase required;
- command-like grammar required;
- script collision scan;
- local alignment suppression;
- high-confidence target validation;
- destructive commands excluded;
- stage acknowledgements configurable;
- manual undo/back action;
- command evaluation corpus includes false-trigger audio.

### 50.10 Threat: stage displays private operational content

Controls:

- operational UI never rendered on stage;
- stage events use explicit allowlisted types;
- errors display in control;
- no raw transcript by default;
- no file paths, API details, costs, download state, or update notices on stage;
- screenshot tests for every stage error condition.

### 50.11 Data sent externally

The privacy screen must enumerate:

#### During Realtime tracking

Sent to OpenAI:

- selected microphone audio while connected/listening, including during soft pause if command listening remains active;
- transcription-session configuration such as language and model.

Not normally sent as part of Realtime transcription:

- entire script;
- Listener video;
- local file metadata;
- permanent key to CandidCue servers.

#### During smart vocabulary analysis

Sent to OpenAI:

- candidate words/phrases and bounded context, or the full script only under an explicitly disclosed implementation/settings choice;
- language and requested schema.

#### During Luna command fallback

Sent to OpenAI:

- detected command phrase;
- compact outline/nearby navigation targets and current state.

#### To CandidCue hosting

- update checks;
- Listener catalogue and selected media downloads;
- optional crash reports only if implemented and opted in.

### 50.12 OpenAI data statement

Product copy should link to current official OpenAI data controls rather than hard-coding a permanent promise. At the research cut-off, API data is not used to train OpenAI models by default, while endpoint-specific abuse-monitoring retention may apply, including Realtime API retention. Reverify this before every privacy-policy release and whenever endpoints change.

### 50.13 Local privacy controls

- no account required;
- no analytics by default;
- crash reporting opt-in;
- session transcript off by default;
- Reveal data folder;
- Export all data;
- delete scripts and revisions;
- clear caches, Listener packs, logs, and saved key;
- configurable recent-script list privacy, later if needed;
- app lock is not required for v1 but may be considered.

### 50.14 Telemetry policy

The preferred v1 is no product analytics. If telemetry is later added:

- explicit opt-in;
- aggregate feature events only;
- no script/transcript/filename/heading/dictionary content;
- no API key or OpenAI project data;
- public event catalogue;
- local preview of what will be sent;
- deletion/disable control.

### 50.15 Security review gates

Before release:

- threat-model review;
- dependency audit for Rust and npm;
- secret-leak test;
- XSS/Markdown corpus;
- IPC authorization review;
- capability and CSP review from production bundle;
- import/archive/path fuzzing;
- Listener signature tamper tests;
- updater signing rehearsal;
- manual proxy/log inspection of external traffic;
- privacy copy matched to actual packet behavior.

---

## 51. Performance and reliability requirements

### 51.1 Product targets

Targets are release goals to validate on the supported hardware matrix:

| Metric | Target |
|---|---:|
| Warm control-window launch | under 1.5 s |
| Cold launch on typical SSD | under 2.5 s |
| Idle memory, control only | preferably under 120–150 MB |
| Stage text animation | 60 fps on supported systems |
| Tracking worker update | p95 under 20 ms per finalized item |
| Editor typing latency | no perceptible input delay |
| 5,000-word compile | under 100–150 ms |
| Stage open after document ready | under 1 s, excluding media download |
| Realtime first usable text | measured target from corpus; preferably under 1 s |
| Local command parse | under 30 ms |
| Luna command fallback | p95 goal under 2 s |
| Installer size | preferably under 25–35 MB excluding Listener packs |
| Two-hour session | no unbounded memory growth or tracking degradation |

Do not sacrifice correctness or security solely to hit an arbitrary installer number.

### 51.2 Main-thread budgets

- no long script compilation on main thread;
- no per-frame DOM queries across the whole document;
- no decoding/resizing large images synchronously;
- no synchronous Tauri invokes inside animation loops;
- no reactive store that re-renders all script blocks per token;
- stage transforms should update one scroll layer and a small number of highlight nodes.

### 51.3 Stage virtualization

For ordinary scripts, render all blocks to guarantee stable measured layout. For extremely long scripts, introduce windowed rendering only if measurements show need, because virtualization can destabilize scroll geometry.

Initial supported limit could be:

- warn above 25,000 spoken words;
- test to 50,000;
- keep a precomputed block-height map;
- no hard crash on larger documents;
- disable expensive preview features when necessary.

### 51.4 Font loading

Bundle application and stage fonts; do not fetch remote fonts. Preload and await `document.fonts.ready` before stage layout acknowledgement. Provide a system-font fallback with stable metrics if a bundled font fails.

### 51.5 Listener performance budget

Measure separately:

- decode CPU/GPU;
- dropped frames;
- stage animation frame time;
- memory per resolution;
- power usage on laptops.

Automatically choose 720p for compact displays and low-power mode. Do not decode 1080p merely because the source exists.

### 51.6 Logging

Use structured Rust logging with levels and rolling files:

- production default: info/warn/error with content redaction;
- retain perhaps 5 files × 2–5 MB;
- debug mode has a bounded duration and visible banner in control;
- frontend logs routed through a redacting bridge or kept in memory;
- no transcript text at default level;
- correlation IDs connect user-facing errors to logs.

### 51.7 Reliability budgets

Track in the test/evaluation harness:

- transcript session failure rate;
- reconnect success;
- empty/truncated/delayed item rate;
- false stage jumps;
- false command activations;
- stage render/layout failures;
- media playback failures;
- save/revision failures.

### 51.8 Graceful degradation hierarchy

When resource pressure is detected:

1. reduce Listener resolution/frame rate;
2. disable Listener blur;
3. reduce nonessential control visualizations;
4. cap transcript diagnostic rendering;
5. keep tracking and stage text highest priority.

Never reduce alignment quality silently because the Listener consumes resources.

---

## 52. Platform requirements and display handling

### 52.1 Supported v1 platforms

Proposed commercial support:

- macOS 12 or later, Apple Silicon and Intel where the selected Tauri/WebView/toolchain remains supported;
- Windows 10 version 22H2 and Windows 11, x64;
- ARM Windows only after specific build and media/WebRTC testing;
- Linux experimental or later.

Reassess minimum versions at implementation and before launch based on Tauri, system WebView, signing, and OpenAI WebRTC behavior.

### 52.2 Why Linux is deferred

Linux distributions vary in WebKitGTK versions, media codecs, portals, microphone permissions, packaging, and display behavior. The code should remain portable, but promising commercial support before a real matrix would undermine the “simple and polished” goal.

### 52.3 Display descriptor

Rust returns:

```ts
interface DisplayDescriptor {
  id: string;               // session-local opaque ID
  name?: string;
  physicalPosition: { x: number; y: number };
  physicalSize: { width: number; height: number };
  scaleFactor: number;
  logicalSize: { width: number; height: number };
  primary: boolean;
  fingerprint: string;
}
```

A fingerprint combines stable available facts such as name, logical/physical dimensions, scale, and relative topology. It is a hint, not a guaranteed hardware identifier.

### 52.4 Display identification

“Identify displays” opens a numbered overlay on each available display. The control list uses matching numbers and dimensions. This is especially important when an Elgato-style prompt display has a generic OS name.

Overlays:

- close automatically after 5–10 seconds;
- do not steal focus unnecessarily;
- are not full stage sessions;
- contain no private script content.

### 52.5 Display removal

If target display disconnects before Live:

- Preflight becomes not ready;
- prompt for another display.

If it disconnects during Live:

- freeze session and soft pause tracking, or continue control tracking only according to setting;
- move stage nowhere automatically to avoid exposing text on the recording/control monitor;
- offer Reopen on available display;
- preserve cursor and Listener state.

### 52.6 Scale and coordinate handling

All native positioning uses the correct logical/physical coordinate APIs. Test:

- mixed DPI monitors;
- negative coordinates;
- monitor above/left of primary;
- display rotation;
- macOS Retina scaling;
- Windows 125%, 150%, and 200%;
- compact 1024×600-like prompt displays;
- ultrawide second displays.

### 52.7 Fullscreen behavior

- stage borderless/fullscreen on selected display;
- no menu/title bar;
- hide cursor after inactivity;
- prevent accidental drag/resize in Live;
- `Esc` returns to windowed or closes stage according to preference;
- control always has an Exit full screen action;
- macOS simple fullscreen should be preferred when it avoids moving the window to another Space and passes testing;
- prevent system sleep only during an active take if user enables it or if product testing proves essential; release the assertion on pause/stop.

### 52.8 Mirroring

Text mirroring is a stage transform, not a different document:

```css
.stage-text-mirror-x {
  transform: scaleX(-1);
  transform-origin: center;
}
```

Implementation detail: apply the mirror to a container whose coordinate system the scroll controller understands. Pointer hit testing may need inverse coordinate handling. Listener video mirror is separate. Support horizontal mirror in v1; vertical mirror only if hardware requirements justify it.

### 52.9 Microphone/platform matrix

Test at least:

- built-in laptop microphones;
- USB microphones;
- Bluetooth headset, with clear warning about profile/quality changes where relevant;
- virtual audio device, best effort;
- device unplug/replug;
- permission deny then allow through system settings;
- app upgrade preserving permission behavior;
- system sleep/wake.

### 52.10 Elgato-style compact prompt display

Treat it as an ordinary second monitor. Optimize profiles for:

- limited vertical resolution;
- camera/lens occlusion or center target;
- small physical viewing area;
- horizontal mirror through beamsplitter;
- large text and narrow safe area;
- hiding nonessential Markdown visuals;
- Listener crop around lens.

CandidCue does not require or integrate with Camera Hub in v1.

---

## 53. Packaging, signing, updating, and release operations

### 53.1 Application identifiers

Choose stable identifiers before shipping, for example:

- bundle/application ID: `com.candidcue.app`;
- product name: `CandidCue`;
- executable name: `CandidCue`;
- custom file type for `.candidcue` only after import behavior is stable.

Changing the identifier later disrupts credentials, permissions, and updates.

### 53.2 macOS distribution

Direct-download path:

- build universal binary if size and CI permit, or separate Intel/Apple Silicon downloads with clear detection;
- sign with Developer ID Application certificate;
- notarize;
- staple ticket where applicable;
- package as DMG;
- include microphone usage description;
- test on a clean machine with Gatekeeper enabled;
- test update from the immediately prior public version.

Mac App Store distribution is not required and may complicate BYOK, sandbox files, and updater behavior. Revisit only for a clear business reason.

### 53.3 Windows distribution

- build with supported MSVC toolchain;
- package MSI or NSIS according to best install/update behavior;
- acquire appropriate code-signing path;
- sign executable and installer;
- test SmartScreen behavior and clean VM install;
- ensure WebView2 runtime requirements are handled by Tauri installer configuration;
- test per-user install/update permissions;
- avoid requiring administrator rights unless necessary.

### 53.4 Updater

Use Tauri’s signed updater. Its update signature validation cannot be treated as optional.

Requirements:

- separate updater key pair from platform code-signing credentials;
- private key stored in secure release environment, backed up offline;
- public key embedded in app configuration;
- versioned update manifest over HTTPS;
- Stable channel for v1; optional Beta later;
- manual Check now and automatic daily check, configurable;
- download in control, never stage;
- do not install during Live;
- offer Install and restart after session;
- release notes shown in control;
- verify upgrade preserves database, key, scripts, profiles, and Listener packs.

### 53.5 Release pipeline

GitHub Actions or equivalent:

1. lint and type-check;
2. JavaScript unit tests;
3. Rust format, lint, and unit/integration tests;
4. dependency and license audit;
5. build production frontend;
6. Tauri test build;
7. WebDriver smoke tests on supported runners;
8. platform builds on native runners;
9. sign and notarize;
10. generate updater artifacts/signatures;
11. generate checksums and software bill of materials;
12. create draft release;
13. manual QA and approval;
14. publish artifacts and update manifest;
15. post-release install/update smoke test.

Release secrets are available only to protected tagged workflows/environments.

### 53.6 Versioning

Use semantic versioning for application releases. Database and document bundle schemas have independent integer versions. Listener packs use their own semantic versions.

- patch: fixes with no document/schema incompatibility;
- minor: backward-compatible features;
- major: user-visible breaking changes or document incompatibility.

Model/config updates that materially change tracking should increment an alignment profile or capability version even when app version remains compatible.

### 53.7 Rollout

For a small product, staged rollout can be simple:

- publish release but delay automatic update manifest for a short verification window;
- validate fresh install and upgrade on clean systems;
- then enable update manifest;
- retain prior download and rollback guidance;
- hotfix only from known tagged source.

### 53.8 Support bundle

A one-click support bundle includes:

- app/Tauri/Rust/WebView/OS versions;
- sanitized configuration values;
- display and microphone names only with user consent;
- stage/session state transitions;
- error correlation IDs;
- redacted logs;
- database schema version and integrity result;
- installed Listener IDs/versions;
- no key, audio, script text, transcript text, or imported images by default.

The user previews included categories before saving.

### 53.9 License and purchase integration

The user described selling the app for a small price, but account/license enforcement is outside the core prompting architecture. Choose one of these later without contaminating v1 internals:

- signed offline license file;
- one-time purchase code activated through a lightweight service;
- storefront-managed licensing;
- honor-system direct download initially.

Any license system must fail gracefully and must never block access to local scripts after a server outage. Store licensing state separately from the OpenAI key. This specification does not require licensing for the first functional build.

---
# Part VII — Implementation and validation plan

## 54. Delivery strategy

### 54.1 Build order principle

Build CandidCue as a sequence of verified vertical slices. Do not create every screen with placeholder services and postpone the risky parts. The two highest-risk assumptions—Realtime behavior inside Tauri system WebViews and whole-script alignment quality—must be proven before polishing the full product.

Each phase ends with:

- a runnable build;
- automated tests for the new behavior;
- a written decision/update for changed assumptions;
- no untracked temporary architecture;
- acceptance evidence.

### 54.2 Phase 0 — technical risk spikes

Phase 0 code may be disposable, but its findings must become fixtures, metrics, or architecture decisions.

#### Spike A: Tauri WebRTC transcription

Build a minimal Tauri 2 app with:

- one control window;
- microphone permission;
- device selection;
- Rust-stored test key;
- Rust-minted short-lived transcription credential;
- WebRTC peer connection;
- data channel event log;
- local VAD;
- manual commits;
- delta and completion display;
- clean disconnect/reconnect.

Test on:

- current supported macOS Intel and Apple Silicon where available;
- current supported Windows 10/11;
- built-in and USB microphones;
- permission denial and later recovery;
- 30-minute continuous session;
- sleep/wake;
- microphone switching.

Capture sanitized provider event streams as test fixtures.

**Exit gate:** WebRTC delivers stable transcript deltas/finals with manual commit control and no unresolvable platform blocker. Otherwise implement the native Rust WebSocket transport spike and compare latency, complexity, and reliability before selecting primary transport.

#### Spike B: system-WebView media and Listener playback

Test:

- H.264 MP4 and WebM variants;
- loop/crossfade without black frames;
- 720p and 1080p decode;
- text animation while video plays;
- opacity, blur, crop, mirror;
- long playback and memory behavior.

**Exit gate:** select codec/encoding matrix and maximum concurrent decoder strategy.

#### Spike C: multi-display stage

Build stage open/position/fullscreen prototype:

- enumerate monitors;
- identify overlays;
- open hidden then reveal;
- macOS simple fullscreen versus native fullscreen;
- Windows mixed DPI;
- compact low-resolution display;
- disconnect/reconnect monitor.

**Exit gate:** documented cross-platform stage strategy with no screen-flash/privacy issue and reliable exit path.

#### Spike D: alignment prototype

Create a CLI or test harness that accepts:

- compiled script tokens;
- time-ordered transcript partial/final events;
- ground-truth intended position.

Implement baseline candidates and weighted local alignment. Test linear reading, fillers, ad-lib, skip, and backward retake.

**Exit gate:** baseline metrics show whole-script alignment is feasible, and failure cases are understood well enough to define Phase 5 work. A simple next-word matcher is not an acceptable result.

#### Spike E: key storage

Validate OS credential storage behavior:

- set/get/delete;
- app upgrade;
- changed bundle identifier in dev versus production;
- multiple OS users;
- denied/unavailable store;
- redacted logs.

**Exit gate:** production identifier and secret-store strategy selected.

### 54.3 Phase 1 — foundation and design shell

Deliver:

- clean Tauri 2/Svelte/TypeScript/Rust repository;
- production identifiers and build configuration;
- control and stage entries;
- design tokens and core components;
- typed IPC framework and error model;
- SQLite migrations and repositories;
- data-directory initialization;
- structured redacted logging;
- settings storage;
- control window-state restore;
- CI for lint/type/unit/build;
- placeholder onboarding/library/editor/settings routes.

Acceptance:

- clean install launches without console errors;
- database initializes and migrates;
- production capability files are narrow;
- stage can handshake through typed events;
- fake secret does not appear in logs;
- app closes cleanly.

### 54.4 Phase 2 — document system

Deliver:

- script library CRUD, search, archive/trash;
- CodeMirror Markdown editor;
- autosave and atomic file persistence;
- external-change detection;
- revisions and restore;
- Markdown compiler worker;
- visual preview;
- outline and navigation targets;
- custom directives;
- image import and scoped asset rendering;
- import/export bundle;
- compile diagnostics and statistics;
- unit/golden/fuzz tests.

Acceptance:

- forced crash during save never destroys the last valid canonical script;
- malicious Markdown fixtures cannot execute script or invoke Tauri APIs;
- token/source mapping survives representative formatting;
- documents reopen identically after restart;
- bundle traversal tests fail safely.

### 54.5 Phase 3 — stage and display system

Deliver:

- display listing/identification;
- display profiles;
- hidden stage creation and readiness handshake;
- fullscreen/borderless behavior;
- reading themes;
- margins, font size, line height, reading band;
- horizontal mirroring;
- manual and fixed-speed modes;
- controlled motion renderer;
- keyboard controls;
- stage blank/freeze;
- compact-display adaptation;
- screenshot/visual regression tests.

Acceptance:

- stage opens on selected display without flashing on control monitor;
- stage contains no control/error UI;
- active block remains stable after resize and mirror toggles;
- manual/fixed mode works with no OpenAI key;
- mixed-DPI and compact-display manual tests pass.

### 54.6 Phase 4 — onboarding, audio, and Realtime transport

Deliver:

- OpenAI key setup and native credential storage;
- key validation/error taxonomy;
- microphone permission flow;
- device selection and local meter;
- end-to-end transcription test;
- Realtime transport abstraction;
- production WebRTC implementation or selected fallback;
- local VAD/manual commits;
- transcript ledger/reconciliation;
- soft/hard pause and reconnect;
- cost/privacy UI;
- captured-event contract tests.

Acceptance:

- permanent key remains outside frontend after initial entry;
- session opens, streams, commits, and closes repeatedly without leaks;
- out-of-order final events reconcile correctly;
- denied permission and lost device have clear recovery;
- manual/fixed modes remain available during provider failure;
- two-hour soak test does not grow memory unboundedly.

### 54.7 Phase 5 — tracking engine

Deliver:

- compiled search indexes and token weights;
- tracking worker and state machine;
- local sequence alignment;
- provisional/final policies;
- ad-lib hold;
- forward skip;
- retake/backward detection;
- global reacquisition;
- manual correction;
- stage lead compensation and movement classes;
- evaluation harness and dashboard/report;
- developer diagnostics.

Implementation loop:

1. Add a failing real-audio scenario.
2. Inspect transcript/model behavior.
3. Improve candidate/scoring/state logic.
4. Run complete corpus.
5. Reject changes that improve one scenario by creating material regressions elsewhere.
6. Version the alignment profile.

Acceptance:

- release corpus meets section 56 thresholds;
- no catastrophic false jumps in long-form soak set;
- stage freezes during unresolved ad-lib rather than guessing;
- retakes work across sentence and paragraph boundaries;
- behavior is reproducible from captured transcript event fixtures.

### 54.8 Phase 6 — commands and vocabulary

Deliver:

- wake phrase setup/test;
- deterministic command parser;
- collision scanner and literal-command directive;
- command masking from alignment;
- Luna strict fallback;
- validated action executor;
- command feedback/history;
- local vocabulary extraction;
- user/global/script dictionary;
- optional Luna vocabulary analysis and cache;
- cost/privacy disclosures;
- command false-trigger corpus.

Acceptance:

- ordinary script reading does not trigger commands above the release false-positive budget;
- common commands resolve locally;
- invalid/late Luna responses never execute;
- ambiguous target produces control-window clarification rather than a wrong jump;
- user dictionary demonstrably improves local matching of test terms;
- UI never claims Realtime prompt steering that is not present.

### 54.9 Phase 7 — Listener mode

Deliver:

- final media-production pipeline and approved initial packs;
- signed catalogue and pack manifests;
- safe download/install/update/remove;
- playback engine with shuffle bag and double buffer;
- lens calibration;
- Listener controls/profile persistence;
- poster/text-only fallback;
- media performance tests;
- provenance/license records.

Acceptance:

- no visible black frame across a 30-minute playback test;
- tampered pack/manifest is rejected;
- offline installed pack works;
- playback failure never interrupts the script;
- stage remains at frame-rate target on supported hardware;
- Listener contrast rules protect readability.

### 54.10 Phase 8 — product completion

Deliver:

- complete onboarding;
- preflight readiness chain;
- final library/editor/live/settings UX;
- empty/loading/error/recovery states;
- accessibility pass;
- keyboard and optional global shortcuts;
- data export/deletion;
- diagnostics/support bundle;
- update UI;
- help and command reference;
- old Electron design parity review.

Acceptance:

- first-time user journey succeeds from a clean OS account;
- every blocking failure has a tested recovery path;
- all stage-visible error cases remain clean;
- keyboard-only core journey works;
- privacy statements match observed traffic.

### 54.11 Phase 9 — release hardening

Deliver:

- dependency/security audit;
- CSP and capabilities audit;
- platform code signing/notarization;
- signed updater;
- clean-machine installer tests;
- migration tests from release candidate schemas;
- update tests from previous signed build;
- performance and two-hour soak reports;
- support/runbook documentation;
- privacy policy and end-user terms appropriate to BYOK/media licensing;
- launch artifacts.

Do not declare v1 complete while signing/updating is untested. These are product features for a paid desktop application.

### 54.12 Suggested milestone cuts

A sensible internal milestone sequence:

1. **M0 Feasibility:** spikes pass.
2. **M1 Local teleprompter:** documents + stage + manual/fixed modes.
3. **M2 Voice proof:** Realtime transcript follows a simple linear script.
4. **M3 Tracking alpha:** skips/ad-libs/retakes on evaluation corpus.
5. **M4 Product beta:** commands, preflight, Listener, full UX.
6. **M5 Release candidate:** signed installers, updater, security/performance gates.

M1 is already a useful local application and reduces the risk of building the product around a single external API path.

---

## 55. Testing strategy

### 55.1 Test pyramid

Use five layers:

1. pure unit/property tests;
2. subsystem integration tests;
3. provider contract/replay tests;
4. Tauri end-to-end tests;
5. manual hardware/platform/evaluation tests.

A visual desktop product cannot be validated by unit tests alone, and a speech-tracking algorithm cannot be validated only by manual impressions.

### 55.2 TypeScript unit tests

Use Vitest or equivalent for:

- Markdown normalization and compiler transformations;
- directive parser;
- source/token mappings;
- sentence segmentation;
- number/contraction aliases;
- vocabulary candidate extraction;
- command wake detector;
- deterministic grammar;
- collision logic;
- transcript ledger and out-of-order events;
- alignment candidate generation;
- scoring/state transitions;
- stage target/motion calculations;
- Listener shuffle selection;
- settings resolution;
- runtime schema validation.

Use fake monotonic clocks for timing behavior.

### 55.3 Property and fuzz tests

Properties:

- normalizing a normalized token is idempotent;
- source ranges remain ordered/in bounds;
- compiler never produces duplicate global token indexes;
- arbitrary Markdown input never emits disallowed HTML elements/attributes;
- command parser never returns an out-of-schema action;
- stage target is always finite and within document bounds;
- importing/exporting a valid CandidCue bundle preserves canonical source/assets;
- transcript event permutations consistent with item order produce the same final ledger;
- alignment never indexes outside token arrays.

Fuzz:

- Markdown/directives;
- bundle/manifest paths;
- JSON IPC payloads;
- sentence segmentation edge cases;
- command phrases and numbers;
- malformed provider events.

### 55.4 Rust unit tests

- secret redaction;
- path containment;
- atomic write failure paths;
- revision retention;
- database repositories and migrations;
- import/export validation;
- MIME/hash checks;
- Listener signature verification;
- download size/path limits;
- OpenAI error mapping;
- retry/idempotency policy;
- settings validation;
- display fingerprint matching;
- support-bundle redaction.

### 55.5 Rust integration tests

Use temporary directories and SQLite databases:

- create/edit/save/reopen script;
- crash point after file rename but before DB commit, then reconcile;
- migration from every prior fixture;
- trash/restore/permanent delete with assets/revisions;
- interrupted Listener download and cleanup;
- catalogue/manifest tampering;
- database backup and recovery;
- updater state restrictions during Live;
- secret-store adapter through a fake implementation.

### 55.6 OpenAI client contract tests

Do not call paid/live endpoints in ordinary CI. Use a local mock HTTP/WebSocket/WebRTC-signaling boundary where practical and captured, sanitized responses.

Test:

- success;
- invalid key;
- model access denied;
- quota exhausted;
- 429 with retry metadata;
- 5xx;
- timeout;
- malformed/oversized JSON;
- schema-valid and schema-invalid Luna output;
- canceled command;
- stale context revision;
- short-lived credential response/expiry.

Run a small gated live smoke suite before releases with a dedicated project/key and hard spend cap.

### 55.7 Realtime event replay tests

Persist sanitized event streams from real sessions:

- normal item deltas/completions;
- completions out of order;
- duplicate completions;
- empty/truncated item;
- connection reset mid-item;
- long utterance forced commit;
- rapid short phrases;
- command phrase split across commits;
- multilingual/code-switch sample if supported.

Replay deterministically into reconciler and aligner. Expected snapshots are golden outputs with tolerances where appropriate.

### 55.8 Tauri end-to-end tests

Use the current recommended Tauri/WebDriverIO service for cross-platform desktop automation where possible. Test:

- fresh launch/onboarding navigation;
- create/edit/autosave/reopen script;
- import/export through dialog abstractions or test hooks;
- open/close stage;
- settings persistence;
- manual/fixed scroll controls;
- mock Realtime transcript driving stage;
- voice command action through transcript injection in test builds;
- Listener install/playback with local fixture server;
- update-available state;
- error and recovery UI.

Provide test-only dependency injection; do not expose transcript injection or mock commands in production builds.

### 55.9 Visual regression

Capture control and stage screenshots at stable dimensions for:

- every major screen;
- empty/library/editor/preflight/live/settings states;
- light/dark control themes if both ship;
- all stage themes;
- mirrored and non-mirrored stage;
- compact and standard display;
- Listener layouts;
- cues/images/heading/list/table visual cases;
- error/paused/reconnecting/blank states.

Use tolerances for platform font rasterization and video posters. Keep a human review step for intentional visual changes.

### 55.10 Accessibility tests

Automated:

- semantic label checks;
- focusability/tab order;
- contrast where measurable;
- no obvious ARIA violations.

Manual:

- keyboard-only onboarding/edit/present/stop;
- VoiceOver on macOS and Narrator on Windows for control UI;
- 200% zoom;
- reduced motion;
- high-contrast stage themes;
- visible focus.

Do not stream transcript deltas into a screen-reader live region.

### 55.11 Security tests

- XSS payloads in every Markdown node and directive field;
- malicious links/image URLs/SVG;
- frontend attempts to invoke unauthorized stage/control commands;
- capability audit in bundled app;
- CSP violation monitoring in test;
- key grep across app-data/log/support bundle after fake-key workflow;
- import ZIP slip/decompression bomb/symlink tests;
- Listener signature/checksum/path/MIME tampering;
- update signature failure;
- dependency vulnerability scanning;
- external network allowlist observation.

### 55.12 Performance tests

Automate where possible:

- launch timing;
- compile benchmark across document sizes;
- tracking update benchmark across corpus;
- stage frame-time trace while voice updates and Listener run;
- memory snapshots over two-hour session;
- Listener decode variants;
- rapid transcript deltas;
- 50,000-word document;
- image-heavy document;
- repeated start/stop/reconnect cycles.

Record hardware/OS/WebView versions with results.

### 55.13 Manual exploratory testing

Scenarios:

- speaker changes pace suddenly;
- whispers/shouts;
- coughs, laughs, pauses, drinks water;
- another person speaks nearby;
- script contains repeated generic language;
- presenter paraphrases then returns;
- presenter skips multiple chapters;
- retakes same paragraph three times;
- says wake phrase as script content;
- command target misspelled in transcript;
- microphone disconnects;
- network disappears;
- display disappears;
- stage loses focus;
- system sleeps;
- Listener media corrupts;
- OpenAI quota ends mid-take.

Exploratory findings should become automated fixtures whenever reproducible.

---

## 56. Speech and alignment evaluation program

### 56.1 Why an evaluation corpus is mandatory

“Feels good on my voice” is not a release standard. Transcription and alignment quality vary by speaker, microphone, pace, vocabulary, environment, and script structure. Build a versioned corpus with intended-position ground truth and run it for every meaningful algorithm/configuration change.

### 56.2 Corpus composition

Initial corpus target: at least 10–20 speakers and 5–10 hours of varied scripted speech before public v1. Include:

- South African English;
- British English;
- American English;
- Australian/New Zealand English;
- additional common English accents where practical;
- gender and age variation among adults;
- clear studio speech and ordinary home/office speech;
- built-in laptop, USB condenser/dynamic, headset, and lower-quality microphone samples;
- quiet, fan noise, keyboard noise, distant speech, and mild room echo;
- delivery speeds roughly 80–190 words per minute;
- product names, people, numbers, dates, currency, URLs, acronyms, and technical terms.

Use participants with consent and define retention/access rules. Synthetic audio may supplement coverage but cannot replace human recordings.

### 56.3 Scenario labels

Every audio/session fixture has a timeline of intended behavior:

- `READ(startToken, endToken)`;
- `PAUSE`;
- `ADLIB(text, expectedHoldToken)`;
- `SKIP(toToken)`;
- `RETAKE(toToken)`;
- `COMMAND(action, expectedTarget)`;
- `NOISE`;
- `OTHER_SPEAKER`;
- `DISCONNECT`;
- `MANUAL_MOVE(toToken)`.

Ground truth may be captured by a recording interface where the reader marks planned behavior or aligned later by a reviewer.

### 56.4 Script families

Include:

1. ordinary conversational product script;
2. dense technical tutorial;
3. proper-noun-heavy script;
4. short social video;
5. long 30-minute course lesson;
6. repeated phrasing and parallel sections;
7. headings/takes/cues/images;
8. command-collision script;
9. numbers and financial content;
10. deliberately difficult tongue-twister or uncommon vocabulary sample.

### 56.5 Core metrics

#### Position error

Absolute difference between predicted semantic cursor and intended token position at sampled times. Report:

- median;
- p90/p95;
- percent within ±3, ±7, ±12, and ±25 tokens;
- error during normal reading versus behavior transitions.

#### Reacquisition latency

Time from the first meaningful return/target words to a confident correct lock after:

- ad-lib;
- forward skip;
- retake;
- reconnect;
- global jump.

#### Catastrophic jump rate

A catastrophic jump is a confident movement to a materially wrong paragraph/section that persists or moves the stage away from intended content. Report per hour and per transition type.

#### Hold correctness

During ad-lib/uncertainty, percent of time stage correctly remains near the last intended position rather than drifting.

#### Retake precision/recall

- precision: committed backward transitions that were true retakes;
- recall: intended retakes detected within acceptable latency.

#### Command precision/recall

- precision among activated commands;
- false activations per hour of ordinary script reading;
- recall for supported command variants;
- target-resolution accuracy;
- local versus Luna resolution rate;
- command execution latency.

#### Motion quality

- number of direction reversals not associated with true retakes;
- scroll velocity/acceleration outliers;
- large correction events;
- time active phrase outside reading band.

#### Provider metrics

- first-delta latency;
- final-item latency;
- empty/truncated/delayed transcript rate;
- word error rate where ground-truth transcript is available;
- disconnect/reconnect rate.

### 56.6 Provisional v1 release thresholds

These are initial product targets and should be revised from real corpus data, not lowered casually after implementation:

- normal clean reading within ±7 spoken tokens at least 95% of sampled time;
- normal noisy reading within ±12 tokens at least 90% of sampled time;
- median reacquisition after a skip or return under 1.2 seconds;
- p95 reacquisition under 2.5 seconds after at least five meaningful matching words;
- zero catastrophic backward jumps in the designated 30-minute clean soak set;
- catastrophic wrong-section jump rate below 0.1 per hour across full release corpus;
- retake precision at least 98%; recall at least 93% for explicit paragraph restarts;
- wake-command precision at least 99.5% and fewer than one false activation per five hours of collision corpus;
- supported command recall at least 95% in quiet conditions;
- local deterministic parser handles at least 90% of standard command test cases;
- stage movement maintains 60 fps p95 frame budget on reference systems without Listener, and remains visually smooth with Listener.

The goal is not word-perfect transcription. The goal is stable, correct prompting.

### 56.7 Experiment reporting

Every alignment change report includes:

- git commit;
- app/compiler/alignment profile/model/delay versions;
- corpus version;
- aggregate metrics;
- metrics by speaker/scenario;
- regressions;
- qualitative failure examples;
- decision.

Keep benchmark results in machine-readable JSON plus a generated human report.

### 56.8 Privacy of corpus

- obtain explicit recording consent;
- store only in restricted development storage;
- do not ship raw recordings with app;
- create sanitized transcript event fixtures where possible;
- document deletion requests and retention;
- never use customer recordings by default;
- separate public/open licensed audio from private internal recordings.

---

## 57. Feature acceptance criteria

### 57.1 First launch

- User sees a concise product explanation, no account creation.
- User can postpone OpenAI setup and still enter the editor/manual mode.
- API key field uses secure input and explains BYOK.
- Saving a valid key clears the plaintext field.
- Microphone permission is contextual, not requested at launch.
- End-to-end test proves transcript flow.
- Display identification and sample stage work.
- User can finish onboarding or return later.

### 57.2 Script library

- Empty state offers New, Import, and sample script.
- Search filters title and source text index without sending content externally.
- Sorting and recent state persist.
- Duplicate, archive/trash, restore, and permanent delete behave as described.
- A corrupted/missing file is flagged with recovery actions, not hidden.

### 57.3 Editor

- Typing remains responsive on supported script sizes.
- Autosave status is truthful.
- Closing/reopening preserves content.
- Markdown syntax and rendered preview correspond.
- Outline navigation moves editor and preview.
- Custom cues/directives insert through UI and compile correctly.
- Images import locally and render without remote leakage.
- Blocking errors link to source.
- Undo/redo uses editor history and remains independent from saved revisions.

### 57.4 Preflight

Ready requires:

- canonical source saved;
- compiler has no blocking error;
- stage display available;
- stage window opened and layout acknowledged;
- selected mode configured;
- if Voice follow: key validated, microphone active, Realtime test/connection ready;
- if Listener enabled: installed media or explicit poster fallback ready.

Warnings may be overridden; failures cannot be mislabeled green.

### 57.5 Stage

- Opens only on selected display.
- Uses effective profile settings.
- Mirrors correctly.
- Supports font, margin, line-height, reading-band controls.
- No operational UI leaks.
- Escape/close works.
- Resize/reopen preserves semantic position.
- Blank/freeze is immediate.
- Images/cues never cause late layout jumps.

### 57.6 Voice tracking

- Linear speech follows with measured release quality.
- Pause/ad-lib holds.
- Return reacquires.
- Forward skip jumps safely.
- Retake moves backward only with strong evidence.
- Repeated generic phrases do not cause wrong global jumps.
- Manual move overrides immediately.
- Provider partial revisions do not make stage twitch.
- Connection loss freezes and recovers without losing document.

### 57.7 Commands

- Wake phrase setting/test works.
- Standard commands resolve deterministically.
- Command words do not move script cursor as spoken prose.
- Script collision scan warns.
- Literal-command block suppresses activation.
- Luna receives only bounded context and strict schema.
- Invalid/stale result is rejected.
- No spoken response enters recording.
- User can see recent command/action in control.

### 57.8 Listener

- User can preview/download/remove packs.
- Integrity failures are clear and safe.
- Calibration aligns eyes to lens target.
- Playback is subtle and continuous.
- Text remains readable.
- Listener can be disabled instantly.
- Offline installed media works.
- Failure falls back to text-only without disrupting take.

### 57.9 Data and privacy

- Scripts are readable Markdown in managed storage.
- Export all data succeeds.
- Delete key removes credential.
- Clear logs/cache/Listener downloads works.
- No audio saved by default.
- No transcript saved by default.
- Privacy panel accurately describes each external request.
- Support bundle defaults contain no user content/secrets.

### 57.10 Updates

- Signed update check works.
- Invalid signature cannot install.
- Update waits until session ends.
- Upgrade preserves scripts/settings/key/profiles/packs.
- User can skip/postpone.
- Application remains usable if update server is unavailable.

---

## 58. Manual QA matrix

### 58.1 Operating systems

At minimum:

- oldest supported macOS, Intel if supported;
- oldest supported macOS, Apple Silicon;
- current macOS, Apple Silicon;
- Windows 10 22H2;
- current Windows 11;
- high-DPI and standard-DPI Windows.

### 58.2 Installation states

- clean install;
- upgrade from each public version;
- uninstall/reinstall with data retained;
- uninstall and manual data removal;
- no network first launch;
- no microphone first launch;
- invalid/revoked key;
- limited disk space;
- non-admin Windows user;
- macOS Gatekeeper clean download.

### 58.3 Display configurations

- one display;
- laptop + normal second monitor;
- compact teleprompter monitor;
- three displays;
- mixed scale factors;
- monitor left/right/above primary;
- mirrored OS display mode;
- display connect/disconnect during Preflight/Live;
- lid closed/open where supported.

### 58.4 Document configurations

- empty and one-line script;
- 100, 5,000, 25,000, 50,000 words;
- headings/no headings/duplicate headings;
- many cues/takes;
- repeated paragraphs;
- image-heavy;
- table/Mermaid if shipped;
- Unicode, emoji, smart punctuation;
- right-to-left text should be explicitly unsupported or tested; do not silently claim it;
- malformed directives;
- external modification conflict.

### 58.5 Audio configurations

- quiet/noisy room;
- built-in/USB/Bluetooth;
- low/high gain;
- echo cancellation on/off if exposed;
- quick device switching;
- permission revocation while app runs;
- network throttling/loss;
- OpenAI 429/5xx simulation;
- long silence;
- continuous speech;
- background speaker.

### 58.6 Listener configurations

- no pack installed;
- starter pack;
- interrupted download;
- insufficient disk;
- corrupt/tampered file;
- 720p/1080p;
- portrait crop/compact display;
- mirror text only/video only/both;
- long playback;
- system sleep/wake.

---

## 59. Using the existing Electron project as design guidance

### 59.1 Migration rule

Treat the Electron application as a visual prototype and behavior reference. Do not copy its runtime shell, preload bridge, IPC channels, database access pattern, Node APIs, packaging, updater, or dependency assumptions.

### 59.2 Audit procedure

Before implementing final UI:

1. Run the Electron build and capture every screen/state at fixed dimensions.
2. Inventory typography, spacing, colors, borders, controls, iconography, and motion.
3. List behaviors worth preserving.
4. List visual inconsistencies and prototype shortcuts to improve.
5. Map old components to the new design-system primitives.
6. Build screenshot parity pages in Tauri.
7. Review side-by-side.
8. Approve intentional differences.

### 59.3 Preserve likely strengths

Based on the intended direction, preserve where present:

- warm, restrained neutral palette;
- modest indigo/accent use;
- calm editorial typography;
- subtle borders and surfaces;
- generous horizontal spacing around 32 px on desktop;
- compact but not cramped 40–42 px controls;
- clear operator versus stage separation;
- dark, distraction-free Live mode;
- sticky primary actions;
- minimal chrome.

These are guidance, not mandatory numeric tokens if the prototype’s exact values are inconsistent.

### 59.4 Improve rather than trace

Use the rebuild to correct:

- inconsistent spacing/radii;
- uncontrolled font variants;
- web-like title bars where native behavior is better;
- hidden save/readiness state;
- prototype-only empty/error states;
- inaccessible contrast/focus;
- duplicated visual controls;
- stage/control coupling;
- oversized Electron-era loading/installer assumptions.

### 59.5 Parity checklist

For each old screen:

| Screen/state | Old screenshot | New screenshot | Preserve | Change | Approved |
|---|---|---|---|---|---|

No old screen is authoritative if it conflicts with this specification’s product model or security architecture.

---

## 60. Future roadmap boundaries

### 60.1 Strong candidates after v1

- local/offline speech recognition provider;
- web companion or browser version;
- phone/foot-pedal/Stream Deck remote;
- camera preview and recording integrations;
- cloud sync with end-to-end-conscious design;
- team review/comments;
- transcript/take review;
- additional Listener packs;
- local reactive Listener selection without claiming intelligence;
- richer chart blocks;
- script writing/rehearsal tools;
- pronunciation/audio correction layer;
- multilingual tracking;
- Linux support.

### 60.2 Architecture seams to preserve

- `RealtimeTranscriptionTransport` for alternate providers/local engines;
- model capability registry;
- versioned compiler/intermediate representation;
- provider-neutral transcript events;
- tracking worker independent of OpenAI;
- command action schema independent of Luna;
- script repository independent of cloud sync;
- Listener catalogue independent of licensing;
- stage bridge independent of remote-control input.

### 60.3 Features to resist

Do not turn CandidCue into a broad video-production suite by default. Recording, editing, collaboration, AI rewriting, and interactive avatars introduce entirely different complexity and competition. Add only when they strengthen the core “speak naturally while the prompt follows” job.

---

## 61. Definition of done for CandidCue v1.0

CandidCue v1.0 is done only when all of the following are true:

### Product

- A new user completes setup and a first take without documentation.
- Markdown scripts can be created, edited, recovered, imported, and exported.
- Manual, fixed-speed, and voice-follow modes are usable.
- Stage works reliably on a second display and compact prompt display.
- Mirroring, typography, margins, reading band, cues, and images work.
- Listener mode is polished but optional.

### Voice

- Realtime session behavior passes platform and soak tests.
- Alignment meets the approved release corpus thresholds.
- Ad-libs, skips, and retakes behave safely.
- Commands meet precision/recall and false-trigger targets.
- Vocabulary behavior is accurately described.

### Engineering

- Saved permanent key remains in native secure storage/Rust boundary after one-time entry.
- Stage has minimal capabilities.
- Database and canonical files recover from tested failure points.
- Memory and performance targets are met or exceptions documented/approved.
- Automated test suites pass in CI.
- Critical manual matrix passes.

### Security and privacy

- Security review gates pass.
- No key/content leakage in support bundle/log tests.
- Markdown/import/pack/update tamper tests pass.
- Privacy text matches actual network behavior.
- User can export/delete local data and key.

### Distribution

- macOS build is signed and notarized.
- Windows build is signed through the selected production process.
- Installer works on clean supported systems.
- Signed updater is verified from a prior build.
- Release/recovery runbooks exist.
- Initial Listener media licensing/provenance is documented.

### Finish quality

- Empty, loading, warning, error, disconnected, and recovery states exist for every primary workflow.
- No stage-visible operational leak remains.
- Keyboard access and basic screen-reader control workflow pass.
- Electron visual-reference parity has been reviewed.
- There are no known P0/P1 defects and no unaccepted P2 defects in the central create–prepare–present workflow.

---
# Appendices

## Appendix A — Default settings and validation ranges

Defaults are initial product hypotheses. Centralize them in versioned configuration and tune through usability/evaluation. Do not duplicate literals across Svelte components, workers, and Rust.

### A.1 General

| Setting | Default | Allowed range/options |
|---|---:|---|
| App opens to | Script library | Library / last script |
| Autosave debounce | 600 ms | 250–2,000 ms internal |
| Revision interval while editing | 5 min | 1–30 min internal |
| Recent revision retention | See §21.4 | policy-controlled |
| Words-per-minute estimate | 130 | 70–220 |
| Update check | Daily | Off / launch / daily / weekly |
| Analytics | Off | Off; opt-in only if later built |
| Saved transcript | Off | Off / 1d / 7d / 30d / forever |

### A.2 Editor

| Setting | Default | Range/options |
|---|---:|---|
| Editor font | bundled/system monospace | approved local fonts |
| Editor font size | 15 px | 11–24 px |
| Editor line height | 1.6 | 1.2–2.0 |
| Preview position | Split right | Source / split / preview |
| Word wrap | On | On/off |
| Read headings | Off | On/off per script |
| Read image alt text | Off | On/off per script |
| Show cues on stage | Subtle | Hidden / subtle / prominent |
| Show silent blocks on stage | Dim | Hidden / dim |

### A.3 Stage typography

Use CSS pixels/logical pixels because the stage is a rendered display, not a print document. UI may label them simply as size.

| Setting | Standard display default | Compact display default | Range |
|---|---:|---:|---:|
| Font size | 64 px | 40 px | 24–180 px |
| Line height | 1.28 | 1.22 | 1.0–1.8 |
| Letter spacing | 0 em | 0 em | -0.03–0.12 em |
| Text column width | 68% | 82% | 35–96% |
| Horizontal safe margin | 16% each | 9% each | 2–32% |
| Reading-band center | 38% | 36% | 20–70% |
| Reading-band half-height | 4% | 5% | 2–12% |
| Past text opacity | 0.42 | 0.48 | 0.1–1.0 |
| Future text opacity | 0.92 | 0.96 | 0.3–1.0 |
| Current underlay opacity | 0.10 | 0.12 | 0–0.35 |
| Paragraph spacing | 0.70 em | 0.60 em | 0.1–2.0 em |
| Top pad | 38 vh | 34 vh | computed |
| Bottom pad | 55 vh | 60 vh | computed |

### A.4 Stage behavior

| Setting | Default | Range/options |
|---|---:|---|
| Prompt mode | Voice follow when configured | Voice / manual / fixed |
| Manual wheel multiplier | 1.0 | 0.25–4.0 |
| Fixed speed | 130 WPM equivalent | 30–300 WPM |
| Pointer hide delay | 1.5 s | 0.5–10 s/off |
| Manual-move tracking grace | 2.5 s | 0.5–8 s |
| Stage acknowledgement | Subtle | Off / subtle |
| Horizontal mirror | Off/profile | On/off |
| Vertical mirror | Off, optional advanced | On/off if shipped |
| Keep screen awake | On during active take | On/off |
| Blank color | Black | theme-safe dark colors only |

### A.5 Motion

| Parameter | Initial value | Tuning range |
|---|---:|---:|
| Spring stiffness | 150 | 60–300 |
| Spring damping | 28 | 12–50 |
| Normal max velocity | 1,200 logical px/s | 400–2,500 |
| Provisional max correction | 180 logical px | 40–400 |
| Large-jump fade out | 90 ms | 0–200 ms |
| Large-jump fade in | 120 ms | 0–250 ms |
| Stage snapshot cap | 30 Hz | 10–60 Hz |
| Reduced-motion transition | 0–60 ms | fixed |

### A.6 Realtime audio

| Setting | Default | Range/options |
|---|---:|---|
| Transcription model | `gpt-realtime-whisper` | capability registry |
| Language | `en` | supported hints |
| Delay profile | Low | Minimal / Low / Balanced / Accurate |
| Local speech-open duration | 100 ms | 50–250 ms |
| End-of-turn silence | 420 ms | 250–800 ms |
| Maximum utterance before commit | 5 s | 2–10 s |
| Ambient calibration | 2 s | 1–5 s |
| Soft-pause auto-disconnect | 10 min | Off / 1–60 min |
| Reconnect attempts | bounded | policy |
| Input effects | echo/noise/AGC on | device/WebView dependent |

### A.7 Tracking profile

Illustrative initial profile:

```json
{
  "profile_version": 1,
  "continuity_back_tokens": 80,
  "continuity_forward_tokens": 260,
  "recent_transcript_min_content_tokens": 4,
  "recent_transcript_max_tokens": 30,
  "locked_threshold": 0.78,
  "soft_threshold": 0.58,
  "global_threshold": 0.84,
  "backward_threshold": 0.90,
  "backward_distance_strict_after": 12,
  "minimum_global_anchor_count": 2,
  "minimum_backward_content_matches": 5,
  "lost_after_ms": 1600,
  "lost_after_content_tokens": 10,
  "stopword_weight": 0.35,
  "normal_weight": 1.0,
  "rare_weight": 1.5,
  "exact_score": 3.0,
  "explicit_alias_score": 2.8,
  "equivalent_score": 2.6,
  "fuzzy_score": 1.7,
  "phonetic_score": 1.4,
  "transcript_insertion_penalty": -0.45,
  "script_gap_penalty": -0.8
}
```

Only the evaluation package should change release defaults. User-facing tracking aggressiveness may map to approved profiles rather than exposing every number.

### A.8 Commands

| Setting | Default | Range/options |
|---|---:|---|
| Wake phrase | CandidCue | validated phrase |
| Wake mode | Strict | Strict / double gate / push-to-command |
| Luna fallback | On | On/off |
| Command model | `gpt-5.6-luna` | capability registry |
| Provisional command display | Off | On/off developer |
| Command timeout soft/hard | 1.5 s / 3 s | internal |
| Stage acknowledgement | 900 ms | 0–2,000 ms |
| Command history in memory | 50 entries | 10–200 |

### A.9 Listener

| Setting | Default | Range |
|---|---:|---:|
| Opacity after dim | 0.22 | 0–0.75 |
| Saturation | 0.55 | 0–1.2 |
| Blur | 1.5 px | 0–12 px |
| Scale | 1.0 | 0.5–2.5 |
| Crossfade | 160 ms | 80–400 ms |
| Compact-display variant | 720p | manifest options |
| Soft pause | Continue | Continue / freeze |
| Hard pause | Freeze | Continue / freeze |
| Hide on blank | Yes | Yes/no |

### A.10 File and network limits

| Item | Proposed limit |
|---|---:|
| Markdown source hard limit | 10 MB |
| Warning threshold | 25,000 spoken words |
| Tested target | 50,000 spoken words |
| Imported image | 25 MB |
| Decoded image dimensions | 100 MP |
| Script asset warning | 500 MB |
| Listener manifest | 1 MB |
| Listener pack files | manifest-declared, capped per catalogue |
| Catalogue response | 2 MB |
| Luna command input | compact, normally under several thousand tokens |
| Vocabulary batch | bounded candidates/context |
| Log retention | 5 × 2–5 MB |

All limits return recoverable validation errors rather than process crashes.

---

## Appendix B — Proposed SQLite schema

This schema is illustrative and should be implemented through numbered migrations. Exact SQLite types and indexes may change, but the ownership and relationships should remain.

```sql
CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE scripts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    canonical_rel_path TEXT NOT NULL UNIQUE,
    source_hash TEXT NOT NULL,
    file_fingerprint TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'archived', 'trash')),
    language TEXT NOT NULL DEFAULT 'en',
    spoken_word_count INTEGER NOT NULL DEFAULT 0,
    estimated_duration_seconds INTEGER NOT NULL DEFAULT 0,
    last_compile_hash TEXT,
    last_compile_version TEXT,
    selected_display_profile_id TEXT,
    selected_tracking_profile_id TEXT,
    selected_listener_pack_id TEXT,
    listener_overrides_json TEXT,
    script_settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT,
    trashed_at TEXT,
    FOREIGN KEY (selected_display_profile_id) REFERENCES display_profiles(id)
        ON DELETE SET NULL,
    FOREIGN KEY (selected_tracking_profile_id) REFERENCES tracking_profiles(id)
        ON DELETE SET NULL
);

CREATE INDEX idx_scripts_status_updated
    ON scripts(status, updated_at DESC);
CREATE INDEX idx_scripts_last_opened
    ON scripts(last_opened_at DESC);
CREATE INDEX idx_scripts_title_nocase
    ON scripts(title COLLATE NOCASE);

CREATE VIRTUAL TABLE script_search USING fts5(
    script_id UNINDEXED,
    title,
    plain_text,
    tokenize = 'unicode61'
);

CREATE TABLE script_revisions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    reason TEXT NOT NULL,
    word_count INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, revision_number),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
);

CREATE INDEX idx_revisions_script_created
    ON script_revisions(script_id, created_at DESC);

CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    extension TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    rel_path TEXT NOT NULL,
    original_name TEXT,
    original_url TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(sha256, rel_path)
);

CREATE TABLE script_asset_references (
    script_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    source_start INTEGER,
    source_end INTEGER,
    role TEXT NOT NULL DEFAULT 'image',
    block_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (script_id, asset_id, source_start),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT
);

CREATE TABLE dictionary_entries (
    id TEXT PRIMARY KEY,
    script_id TEXT,
    written_term TEXT NOT NULL,
    canonical_spoken TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    source TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('user', 'directive', 'generated')),
    approved INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(script_id, written_term COLLATE NOCASE),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
);

CREATE INDEX idx_dictionary_global
    ON dictionary_entries(script_id, written_term COLLATE NOCASE);

CREATE TABLE script_analyses (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    model TEXT,
    prompt_schema_version TEXT,
    dictionary_version TEXT,
    language TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, source_hash, analyzer_version,
           model, prompt_schema_version, dictionary_version, language),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
);

CREATE TABLE display_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_fingerprint TEXT,
    display_descriptor_json TEXT,
    stage_settings_json TEXT NOT NULL,
    listener_geometry_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE tracking_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile_version INTEGER NOT NULL,
    built_in INTEGER NOT NULL DEFAULT 0,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE listener_packs (
    pack_id TEXT NOT NULL,
    version TEXT NOT NULL,
    display_name TEXT NOT NULL,
    manifest_rel_path TEXT NOT NULL,
    selected_variant TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    state TEXT NOT NULL
        CHECK (state IN ('installing', 'installed', 'failed', 'rollback')),
    last_verified_at TEXT,
    installed_at TEXT NOT NULL,
    last_used_at TEXT,
    PRIMARY KEY (pack_id, version)
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    script_source_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    mode TEXT NOT NULL
        CHECK (mode IN ('voice', 'manual', 'fixed')),
    start_token_index INTEGER NOT NULL DEFAULT 0,
    end_token_index INTEGER,
    duration_ms INTEGER,
    soft_pause_ms INTEGER NOT NULL DEFAULT 0,
    command_count INTEGER NOT NULL DEFAULT 0,
    retake_count INTEGER NOT NULL DEFAULT 0,
    reconnect_count INTEGER NOT NULL DEFAULT 0,
    manual_correction_count INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL,
    metrics_json TEXT,
    transcript_retained INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_sessions_script_started
    ON sessions(script_id, started_at DESC);

CREATE TABLE session_transcript_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    commit_sequence INTEGER NOT NULL,
    provider_item_id TEXT,
    audio_start_ms INTEGER,
    audio_end_ms INTEGER,
    transcript TEXT NOT NULL,
    disposition TEXT NOT NULL
        CHECK (disposition IN ('script', 'command', 'discarded')),
    confidence_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, commit_sequence),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### B.1 Search synchronization

Update `script_search` after successful canonical save and compile/plain-text extraction. Wrap FTS updates in the same SQLite transaction as script metadata. On startup, rebuild missing FTS rows from managed Markdown without altering canonical files.

### B.2 JSON columns

Validate JSON in Rust before insert/update. Consider SQLite `json_valid()` checks where the bundled SQLite supports them consistently. Version every complex JSON object internally.

### B.3 Timestamps

Store UTC RFC 3339 strings or integer milliseconds consistently. Convert to local time only in UI. Use a monotonic clock for session latency/duration calculations and wall clock for persisted dates.

### B.4 Optional transcript table

Create the table from the beginning if it simplifies migrations, but write no rows unless retention is enabled. Deleting a session or changing retention should securely remove rows as far as ordinary filesystem/database semantics permit; do not promise forensic secure deletion on SSDs.

---
## Appendix C — Shared TypeScript contracts

These contracts illustrate the shape of the shared package. Generate corresponding Rust types where practical and keep schema tests across the boundary.

```ts
export type Uuid = string;
export type IsoDateTime = string;

export interface Revisioned<T> {
  revision: number;
  value: T;
}

export interface ScriptSummary {
  id: Uuid;
  title: string;
  status: 'draft' | 'ready' | 'archived' | 'trash';
  language: string;
  spokenWordCount: number;
  estimatedDurationSeconds: number;
  updatedAt: IsoDateTime;
  lastOpenedAt?: IsoDateTime;
  previewText: string;
  hasWarnings: boolean;
}

export interface ScriptDocument extends ScriptSummary {
  source: string;
  sourceHash: string;
  scriptRevision: number;
  settings: ScriptSettings;
  selectedDisplayProfileId?: Uuid;
  selectedTrackingProfileId?: Uuid;
  selectedListener?: ListenerSelection;
}

export interface ScriptSettings {
  schemaVersion: 1;
  readHeadings: boolean;
  readImageAltText: boolean;
  readInlineCode: boolean;
  cueVisibility: 'hidden' | 'subtle' | 'prominent';
  silentBlockVisibility: 'hidden' | 'dim';
  wordsPerMinuteEstimate: number;
  stageOverrides?: Partial<StageSettings>;
}
```

### C.1 Compiler contracts

```ts
export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface CompileDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  blocking: boolean;
  source?: { utf16Start: number; utf16End: number; line?: number; column?: number };
  suggestedAction?: 'open_source' | 'fix_directive' | 'import_asset' |
    'mark_literal_command' | 'change_wake_phrase';
}

export interface OutlineNode {
  id: string;
  level: number;
  title: string;
  normalizedTitle: string;
  blockId: string;
  startTokenIndex: number;
  endTokenIndex: number;
  children: OutlineNode[];
}

export interface SentenceUnit {
  id: string;
  blockId: string;
  startTokenIndex: number;
  endTokenIndex: number;
  normalizedText: string;
  source: { utf16Start: number; utf16End: number };
}

export interface NavigationTarget {
  id: string;
  type: 'beginning' | 'end' | 'heading' | 'take' | 'sentence' |
    'paragraph' | 'phrase';
  label: string;
  normalizedLabel: string;
  tokenIndex: number;
  blockId: string;
  ordinalWithinLabel?: number;
}

export interface CompiledBlock {
  id: string;
  kind: 'paragraph' | 'heading' | 'list_item' | 'blockquote' |
    'image' | 'table' | 'diagram' | 'cue' | 'silent' | 'stage_only' |
    'code' | 'divider';
  renderNodes: SafeRenderNode[];
  startTokenIndex?: number;
  endTokenIndex?: number;
  source: { utf16Start: number; utf16End: number };
  spoken: boolean;
  assetIds?: string[];
  layoutHints?: Record<string, string | number | boolean>;
}

export type SafeRenderNode =
  | { type: 'text'; text: string; marks?: ('strong' | 'em' | 'strike' | 'code')[]; tokenIndexes?: number[] }
  | { type: 'line_break' }
  | { type: 'link'; label: SafeRenderNode[]; href?: string; external: boolean }
  | { type: 'image'; assetId: string; alt: string }
  | { type: 'cue'; cueType: string; label: string };
```

Do not use `SafeRenderNode` as a disguised arbitrary HTML field.

### C.2 Display and stage contracts

```ts
export interface StageSettings {
  schemaVersion: 1;
  themeId: string;
  background: string;
  foreground: string;
  fontFamilyId: string;
  fontSizePx: number;
  lineHeight: number;
  letterSpacingEm: number;
  columnWidthPercent: number;
  readingBandCenterPercent: number;
  readingBandHalfHeightPercent: number;
  pastOpacity: number;
  futureOpacity: number;
  currentUnderlayOpacity: number;
  mirrorX: boolean;
  mirrorY: boolean;
  showCues: boolean;
  stageAcknowledgements: boolean;
  reducedMotion: boolean;
}

export interface DisplayProfile {
  id: Uuid;
  name: string;
  displayFingerprint?: string;
  stage: StageSettings;
  listener?: ListenerGeometry;
  updatedAt: IsoDateTime;
}

export interface StageSessionEnvelope {
  schemaVersion: 1;
  sessionId: Uuid;
  sessionGeneration: number;
  stageGeneration: number;
  scriptId: Uuid;
  sourceHash: string;
  compileRevision: number;
  stageSettings: StageSettings;
  renderDocument: StageRenderDocument;
  listener?: ListenerStageSelection;
  initialTokenIndex: number;
}

export interface StageRenderDocument {
  schemaVersion: 1;
  title: string;
  blocks: CompiledBlock[];
  tokenToNode: Array<{ tokenIndex: number; blockId: string; nodeKey: string }>;
  assets: Record<string, { url: string; mime: string; width?: number; height?: number }>;
}

export interface StageStatus {
  exists: boolean;
  visible: boolean;
  fullscreen: boolean;
  displayFingerprint?: string;
  stageGeneration: number;
  sessionId?: Uuid;
  hydrated: boolean;
  layoutReady: boolean;
  lastTrackingRevision?: number;
  mediaHealthy: boolean;
}
```

### C.3 Audio and transport contracts

```ts
export type RealtimeState =
  | 'idle'
  | 'requesting_permission'
  | 'opening_microphone'
  | 'minting_credential'
  | 'negotiating'
  | 'ready'
  | 'listening'
  | 'soft_paused'
  | 'reconnecting'
  | 'stopping'
  | 'recoverable_error'
  | 'fatal_error';

export interface AudioDeviceInfo {
  deviceId: string;
  groupId?: string;
  label: string;
  isDefault: boolean;
  available: boolean;
}

export interface AudioLevelSnapshot {
  rms: number;
  peak: number;
  noiseFloor: number;
  speaking: boolean;
  clipped: boolean;
  signalPresent: boolean;
  generatedAtMs: number;
}

export interface TranscriptionConfig {
  model: string;
  language?: string;
  delay: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  requestLogprobs: boolean;
}

export interface EphemeralCredential {
  value: string;
  expiresAt: number;
  sessionType: 'transcription';
  credentialGeneration: number;
}
```

### C.4 Transcript and tracking contracts

```ts
export interface TokenLogprob {
  token: string;
  logprob: number;
}

export interface FinalTranscriptItem {
  sessionGeneration: number;
  itemId: string;
  commitSequence: number;
  audioStartMs: number;
  audioEndMs: number;
  transcript: string;
  tokens: TranscriptToken[];
  logprobs?: TokenLogprob[];
}

export interface TranscriptToken {
  surface: string;
  normalized: string;
  confidence?: number;
  startMs?: number;
  endMs?: number;
}

export type TrackingState =
  | 'following'
  | 'holding'
  | 'searching'
  | 'retake_candidate'
  | 'command_pending'
  | 'paused'
  | 'reconnecting';

export interface TrackingSnapshot {
  schemaVersion: 1;
  revision: number;
  sessionId: Uuid;
  sessionGeneration: number;
  stageGeneration: number;
  scriptId: Uuid;
  tokenIndex: number;
  committedTokenIndex: number;
  blockId: string;
  sentenceId: string;
  confidence: number;
  state: TrackingState;
  provisional: boolean;
  movement: 'hold' | 'advance' | 'skip' | 'retake' | 'command' | 'manual';
  sourceItemIds: string[];
  generatedAtMs: number;
}
```

### C.5 Command contracts

```ts
export type CommandAction =
  | { action: 'start' | 'pause' | 'resume' | 'hard_pause' | 'stop' }
  | { action: 'go_to_target'; targetId: string }
  | { action: 'next_section' | 'previous_section' }
  | { action: 'move_relative'; direction: 'forward' | 'backward'; amount: number; unit: 'sentence' | 'paragraph' | 'section' }
  | { action: 'restart_unit'; unit: 'sentence' | 'paragraph' | 'section' | 'take' }
  | { action: 'set_font_size'; valuePx: number }
  | { action: 'adjust_font_size'; deltaSteps: number }
  | { action: 'set_margins'; valuePercent: number }
  | { action: 'toggle_mirror'; axis: 'x' | 'y'; value?: boolean }
  | { action: 'blank_stage' | 'unblank_stage' }
  | { action: 'set_listener'; enabled: boolean }
  | { action: 'adjust_reading_band'; deltaPercent: number }
  | { action: 'set_scroll_mode'; mode: 'voice' | 'manual' | 'fixed' }
  | { action: 'unknown'; reason?: string };

export interface CommandCandidate {
  id: Uuid;
  sessionGeneration: number;
  contextRevision: number;
  itemIds: string[];
  rawTranscript: string;
  normalizedTranscript: string;
  wakeAlias: string;
  wakeConfidence: number;
  scriptCollisionScore: number;
  createdAtMs: number;
}

export interface ValidatedCommand {
  candidateId: Uuid;
  source: 'local' | 'luna';
  action: CommandAction;
  confidence: number;
  requiresConfirmation: boolean;
  contextRevision: number;
  humanLabel: string;
}
```

### C.6 Listener contracts

```ts
export interface ListenerCatalogueEntry {
  packId: string;
  latestVersion: string;
  displayName: string;
  description: string;
  thumbnailUrl: string;
  approximateBytes: number;
  variants: string[];
  minimumAppVersion: string;
  installedVersion?: string;
}

export interface ListenerSelection {
  packId: string;
  version: string;
  variant: string;
}

export interface ListenerGeometry {
  anchorX: number;
  anchorY: number;
  scale: number;
  cropX: number;
  cropY: number;
  cropZoom: number;
  opacity: number;
  blurPx: number;
  saturation: number;
  mirrorVideo: boolean;
}

export interface ListenerStageSelection extends ListenerSelection {
  geometry: ListenerGeometry;
  clipUrls: Array<{
    id: string;
    url: string;
    mime: string;
    durationMs: number;
    posterUrl: string;
  }>;
}
```

### C.7 Application error codes

Suggested stable codes:

```text
AUTH_KEY_INVALID
AUTH_MODEL_UNAVAILABLE
AUTH_REALTIME_UNAVAILABLE
QUOTA_EXHAUSTED
RATE_LIMITED
NETWORK_OFFLINE
NETWORK_TIMEOUT
PROVIDER_UNAVAILABLE
MIC_PERMISSION_DENIED
MIC_DEVICE_MISSING
MIC_DEVICE_LOST
MIC_NO_SIGNAL
MIC_CLIPPING
REALTIME_NEGOTIATION_FAILED
REALTIME_CONNECTION_LOST
REALTIME_NO_TRANSCRIPTS
SCRIPT_CONFLICT
SCRIPT_SAVE_FAILED
SCRIPT_FILE_MISSING
SCRIPT_COMPILE_FAILED
IMPORT_INVALID_FORMAT
IMPORT_UNSAFE_PATH
ASSET_UNSUPPORTED
ASSET_TOO_LARGE
DATABASE_MIGRATION_FAILED
DATABASE_INTEGRITY_FAILED
STAGE_DISPLAY_MISSING
STAGE_OPEN_FAILED
STAGE_LAYOUT_FAILED
LISTENER_NOT_INSTALLED
LISTENER_MANIFEST_INVALID
LISTENER_SIGNATURE_INVALID
LISTENER_DECODE_FAILED
UPDATE_SIGNATURE_INVALID
UPDATE_INSTALL_FAILED
INTERNAL_UNEXPECTED
```

The UI maps codes to localized copy and recovery actions. Do not branch on English provider messages.

---

## Appendix D — Illustrative Tauri configuration

These snippets show intent, not a guaranteed schema-perfect final file. Validate against the Tauri version pinned by the project.

### D.1 `tauri.conf.json` outline

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "CandidCue",
  "version": "0.1.0",
  "identifier": "com.candidcue.app",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "control",
        "title": "CandidCue",
        "url": "control.html",
        "width": 1240,
        "height": 820,
        "minWidth": 980,
        "minHeight": 680,
        "visible": false,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": "default-src 'self' asset: customprotocol:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: blob: data:; media-src 'self' asset: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost https://api.openai.com; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
      "assetProtocol": {
        "enable": true,
        "scope": []
      }
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "minimumSystemVersion": "12.0"
    },
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" }
    }
  },
  "plugins": {
    "updater": {
      "pubkey": "<UPDATER_PUBLIC_KEY>",
      "endpoints": [
        "https://updates.candidcue.com/stable/{{target}}/{{arch}}/{{current_version}}"
      ]
    }
  }
}
```

Do not leave an empty broad asset scope in production. Populate scope dynamically through a custom protocol or statically only for app-managed roots using the official supported mechanism.

### D.2 Control capability

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "control-capability",
  "windows": ["control"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "window-state:default",
    "updater:allow-check",
    "updater:allow-download-and-install",
    "process:allow-restart",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister"
  ]
}
```

Remove global shortcut permissions when the feature is off at build level or not shipped. Prefer custom commands for opening approved links rather than broad opener permissions.

### D.3 Stage capability

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "stage-capability",
  "windows": ["stage"],
  "permissions": [
    "core:event:allow-listen",
    "core:event:allow-unlisten"
  ]
}
```

If stage window operations are entirely Rust-driven, event listening may be the only needed frontend-facing permission.

### D.4 Stage creation pseudocode in Rust

```rust
pub async fn open_stage(
    app: &tauri::AppHandle,
    request: OpenStageRequest,
) -> Result<StageOpenResult, AppError> {
    validate_request(&request)?;
    let monitor = resolve_monitor(app, &request.display_fingerprint)?;
    let generation = next_stage_generation();

    if let Some(existing) = app.get_webview_window("stage") {
        existing.close().map_err(AppError::from)?;
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        "stage",
        tauri::WebviewUrl::App("stage.html".into()),
    )
    .title("CandidCue Stage")
    .decorations(false)
    .resizable(false)
    .visible(false)
    .skip_taskbar(true)
    .build()
    .map_err(AppError::from)?;

    position_to_monitor(&window, &monitor)?;
    coordinator.register_stage(generation, request.session_id);

    Ok(StageOpenResult { generation })
}
```

The final implementation must account for asynchronous page hydration, per-platform focus/fullscreen calls, and stale generation cleanup.

### D.5 macOS microphone declaration

The bundle’s `Info.plist` requires a user-facing microphone usage description. Example copy:

```text
CandidCue uses the microphone while voice tracking or a microphone test is active so it can transcribe your speech and follow your script.
```

Use Tauri’s supported plist/bundle configuration mechanism for the pinned version. Verify the string appears in the actual signed app bundle.

### D.6 Application menu

macOS:

- CandidCue: About, Settings, Hide, Quit;
- File: New Script, Import, Save, Export;
- Edit: Undo/Redo/Cut/Copy/Paste/Select All;
- View: Toggle Preview, Increase/Decrease Editor Text, Enter/Exit Stage Full Screen where appropriate;
- Session: Present, Start/Pause, Hard Pause, Stop, Blank Stage;
- Window: Control, Stage, standard window entries;
- Help: Command reference, Privacy, Diagnostics, Website.

Windows may use a compact menu or command palette while retaining keyboard equivalents.

---

## Appendix E — OpenAI request and event flows

### E.1 Create a short-lived transcription credential in Rust

Conceptual request:

```http
POST https://api.openai.com/v1/realtime/client_secrets
Authorization: Bearer <PERMANENT_KEY_FROM_SECRET_STORE>
Content-Type: application/json

{
  "expires_after": {
    "anchor": "created_at",
    "seconds": 600
  },
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "transcription": {
          "model": "gpt-realtime-whisper",
          "language": "en",
          "delay": "low"
        },
        "turn_detection": null
      }
    },
    "include": [
      "item.input_audio_transcription.logprobs"
    ]
  }
}
```

Implementation requirements:

- construct through typed structs;
- use current API schema rather than copying this body blindly;
- include a privacy-preserving safety identifier only if the product has an appropriate stable local identifier and the current OpenAI guidance calls for it;
- short timeout;
- no body/header logs;
- return only `value`, `expires_at`, and local generation to control;
- never cache a client secret beyond its connection attempt.

### E.2 WebRTC connection in control frontend

Illustrative pseudocode:

```ts
async function connectRealtime(
  credential: EphemeralCredential,
  stream: MediaStream,
): Promise<WebRtcConnection> {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel('oai-events');

  const [track] = stream.getAudioTracks();
  if (!track) throw appError('MIC_DEVICE_MISSING');
  pc.addTrack(track, stream);

  dc.addEventListener('message', (event) => {
    const parsed = parseRealtimeEvent(event.data);
    realtimeEventBus.push(parsed);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential.value}`,
      'Content-Type': 'application/sdp',
    },
    body: offer.sdp,
  });

  if (!response.ok) throw await mapRealtimeHandshakeError(response);

  await pc.setRemoteDescription({
    type: 'answer',
    sdp: await response.text(),
  });

  await waitForDataChannelOpen(dc);
  return new WebRtcConnection(pc, dc, credential.expiresAt);
}
```

Because CandidCue is transcription-only, do not create or autoplay a remote audio output element unless the selected Realtime connection mode unexpectedly requires it. Verify behavior during Phase 0.

### E.3 Manual commit event

When local VAD closes an utterance:

```ts
function commitCurrentTurn(connection: WebRtcConnection, meta: CommitMeta) {
  commitLedger.recordPending(meta);
  connection.send({ type: 'input_audio_buffer.commit' });
}
```

If the current WebRTC transcription contract requires additional clear/reset events, capture and implement them in the provider adapter. Do not send commits before the data channel is open or for an empty local speech segment.

### E.4 Transcript event adapter

```ts
function adaptProviderEvent(raw: unknown): TranscriptEvent | null {
  const event = RealtimeServerEventSchema.parse(raw);

  switch (event.type) {
    case 'conversation.item.input_audio_transcription.delta':
      return {
        type: 'delta',
        itemId: event.item_id,
        text: event.delta,
        receivedAtMs: performance.now(),
      };

    case 'conversation.item.input_audio_transcription.completed':
      return {
        type: 'completed',
        itemId: event.item_id,
        text: event.transcript,
        logprobs: normalizeLogprobs(event.logprobs),
      };

    case 'error':
      return mapProviderError(event);

    default:
      return null;
  }
}
```

Persist captured unknown events in developer memory diagnostics only after redaction so API evolution can be investigated.

### E.5 Luna command request

Use the current Responses API or supported structured-output endpoint for `gpt-5.6-luna`. Conceptual input:

```json
{
  "model": "gpt-5.6-luna",
  "store": false,
  "input": [
    {
      "role": "developer",
      "content": [
        {
          "type": "input_text",
          "text": "Interpret only a CandidCue teleprompter command. Use the provided action schema. Never invent a target. Return unknown when ambiguous."
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Command: take me back to the pricing close\nCurrent section: Demo\nTargets: Opening; Problem; Demo; Pricing; Closing"
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "control_candidcue",
      "description": "Return one bounded CandidCue command.",
      "strict": true,
      "parameters": { "...": "schema from section 33.8" }
    }
  ],
  "tool_choice": { "type": "function", "name": "control_candidcue" },
  "parallel_tool_calls": false
}
```

Validate the response twice:

1. structural JSON/schema validation;
2. domain validation against current targets, settings ranges, session state, and context revision.

Use `store: false` where supported and appropriate. Recheck current endpoint/data controls at implementation time.

### E.6 Vocabulary analysis request

Developer instruction should be narrow:

```text
Given candidate terms extracted from a teleprompter script and brief context,
identify only genuinely unusual names, brands, acronyms, technical terms,
numbers, and likely speech-to-text variants. Do not rewrite the script. Do not
add ordinary words. Return the strict schema. A transcript alias is a possible
recognition variant, not a recommended spelling.
```

Input object:

```json
{
  "language": "en",
  "candidates": [
    {
      "surface": "RuinWeave",
      "contexts": ["The RuinWeave bearer enters the chamber."]
    },
    {
      "surface": "CandidCue",
      "contexts": ["Open CandidCue and select the script."]
    }
  ],
  "existing_dictionary": []
}
```

Result schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["terms"],
  "properties": {
    "terms": {
      "type": "array",
      "maxItems": 300,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "surface", "canonical_spoken", "aliases",
          "category", "importance", "case_sensitive", "notes"
        ],
        "properties": {
          "surface": { "type": "string", "maxLength": 200 },
          "canonical_spoken": { "type": "string", "maxLength": 300 },
          "aliases": {
            "type": "array",
            "maxItems": 12,
            "items": { "type": "string", "maxLength": 200 }
          },
          "category": {
            "type": "string",
            "enum": ["person", "place", "brand", "acronym", "technical", "number", "other"]
          },
          "importance": { "type": "number", "minimum": 0, "maximum": 1 },
          "case_sensitive": { "type": "boolean" },
          "notes": { "type": "string", "maxLength": 300 }
        }
      }
    }
  }
}
```

### E.7 API failure mapping

| HTTP/provider condition | App code | Behavior |
|---|---|---|
| 401/invalid auth | `AUTH_KEY_INVALID` | stop operation; key setup |
| model permission/access | `AUTH_MODEL_UNAVAILABLE` | explain required model; manual mode |
| quota/billing | `QUOTA_EXHAUSTED` | stop voice; no retry loop |
| 429 temporary | `RATE_LIMITED` | respect retry; allow manual mode |
| timeout/offline | `NETWORK_TIMEOUT`/`NETWORK_OFFLINE` | reconnect or manual mode |
| 5xx | `PROVIDER_UNAVAILABLE` | bounded retry |
| malformed response | `PROVIDER_UNAVAILABLE` plus diagnostic | no unsafe fallback |
| Luna schema invalid | local command unknown | never execute |
| expired client secret | mint fresh and reconnect | no reuse |

---
## Appendix F — Product copy and error catalogue

Copy should be calm, precise, and operational. Avoid anthropomorphizing transcription or implying certainty the system does not have.

### F.1 Welcome

**Heading:** Speak naturally. Keep your place.

**Body:** CandidCue is a voice-following teleprompter for your second screen. Write or import a Markdown script, choose a microphone, and present while the text follows you.

**Primary:** Create your first script

**Secondary:** Import Markdown

**Readiness list:**

- Add your OpenAI API key for voice tracking.
- Choose and test a microphone.
- Select the screen used by your teleprompter.

**Privacy link:** What CandidCue sends to OpenAI

### F.2 API key setup

**Heading:** Connect OpenAI

**Body:** CandidCue is bring-your-own-key. Your key is stored in your operating system’s secure credential store and is used directly from this app. CandidCue does not send it to CandidCue servers.

**Field label:** OpenAI API key

**Helper:** Voice tracking uses OpenAI Realtime transcription. Smart command interpretation and vocabulary analysis use GPT-5.6 Luna.

**Primary:** Validate and save

**Secondary:** Use manual mode for now

**Valid:** Key saved. Realtime transcription is available.

**Partial:** The key is valid, but CandidCue could not access `<model or endpoint>`. Manual and fixed-speed modes are still available.

**Invalid:** OpenAI rejected this key. Check that it is active and belongs to the project you intend to bill.

**Quota:** The key is valid, but the OpenAI project has no available quota or billing access.

### F.3 Microphone permission

**Heading:** Allow microphone access

**Body:** CandidCue uses your microphone only while a test or voice-tracking session is active. During voice tracking, audio is sent to OpenAI for live transcription. Audio is not recorded or saved by CandidCue by default.

**Primary:** Allow and choose microphone

**Secondary:** Not now

**Denied:** Microphone access is blocked. Allow CandidCue in your system privacy settings, then try again.

### F.4 Microphone test

**Heading:** Test your voice

**Prompt:** Say: “CandidCue is following my voice.”

**Listening:** Listening…

**Waiting for text:** Audio detected. Waiting for transcription…

**Success:** Transcription is working.

**No signal:** CandidCue cannot hear this microphone. Check the selected device and input level.

**Too low:** The signal is very quiet. Move closer or increase the microphone level.

**Clipping:** The signal is clipping. Reduce the microphone gain for more reliable transcription.

**Test unusual term:** Test a script word

**Alias action:** Accept this transcript as an alias

**Dictionary truth note:** Dictionary terms improve CandidCue’s local script matching. The current Realtime model does not accept them as a custom uploaded dictionary.

### F.5 Display setup

**Heading:** Choose the prompt screen

**Body:** Select the display placed next to or inside your teleprompter.

**Primary:** Identify displays

**Test action:** Show test on this display

**Stage test copy:** CandidCue stage · Display 2

**Missing:** The saved display is no longer connected. Choose another display or reconnect it.

### F.6 Listener setup

**Heading:** Add a Listener

**Body:** A Listener is a silent looping person behind the script. They do not hear you, respond, or use your camera. The purpose is simply to give you someone to look at while you speak.

**Actions:** Preview · Download · Use Listener · Not now

**Download:** Downloading `<name>`… `<progress>`

**Ready:** Installed and available offline.

**Integrity failure:** This Listener pack could not be verified and was not installed.

### F.7 Editor empty state

**Title placeholder:** Untitled script

**Editor placeholder:** Start writing, paste a script, or import Markdown…

**Preview empty:** Your rendered script will appear here.

**Vocabulary empty:** CandidCue will suggest unusual names and terms when you prepare the script.

### F.8 Save states

- Saving…
- Saved
- Save failed
- Changed outside CandidCue

**Save failed body:** Your current text is still open and has not been discarded.

**Actions:** Retry · Copy all text · Reveal data folder

**External conflict heading:** This script changed on disk

**Body:** Choose which version to keep. CandidCue will save the other version as a revision.

**Actions:** Keep CandidCue version · Load disk version · Save both

### F.9 Compile/readiness messages

- **Ready:** Script compiled and ready to present.
- **Wake collision:** This passage sounds like a CandidCue command. Mark it as literal speech or change the wake phrase.
- **Missing image:** This image file is missing. Re-import it or hide the block on stage.
- **Malformed cue:** CandidCue could not parse this directive.
- **Duplicate target:** More than one heading is named “Pricing.” Voice navigation may require an ordinal.
- **Large script:** This is a long script. It will work, but preparation and global reacquisition may take longer.
- **Remote image blocked:** Remote images are not loaded during a take. Import a local copy.

### F.10 Preflight status labels

| Check | Checking | Ready | Problem |
|---|---|---|---|
| Script | Compiling… | Script ready | Script needs attention |
| OpenAI | Connecting… | OpenAI ready | OpenAI unavailable |
| Microphone | Testing… | Microphone ready | Microphone unavailable |
| Stage | Opening… | Stage ready | Stage display unavailable |
| Listener | Loading… | Listener ready | Listener unavailable |

**Primary:** Start session

**Voice-unavailable alternative:** Start in manual mode

**Warning override:** Start with warning

### F.11 Live statuses

- Ready to start
- Listening
- Following
- Holding your place
- Looking for your place
- Retake detected
- Command heard
- Paused — still listening for “CandidCue, resume”
- Hard paused — microphone off
- Reconnecting — position held
- Microphone disconnected — position held
- Stage disconnected — session paused

The stage should not show these diagnostic phrases except optional short command acknowledgements.

### F.12 Live actions

- Start
- Pause
- Resume
- Hard pause
- Stop session
- Back one sentence
- Restart paragraph
- Next section
- Blank stage
- Reopen stage
- Switch to manual mode

### F.13 Command acknowledgements

Stage/control human labels:

- Started
- Paused
- Resumed
- Chapter 1
- Pricing
- Back one sentence
- Restart paragraph
- Text 72 px
- Margins 14%
- Text mirrored
- Stage blanked
- Listener on

Failures in control:

- I couldn’t find “Pricing close.”
- There are two sections named “Results.” Choose one in the control window.
- That command is not available during prompting.
- The command arrived after the session changed, so it was ignored.

Avoid “I didn’t understand you” language where a concrete failure is known.

### F.14 Network/provider failures

**Connection lost**

CandidCue is holding the current position while it reconnects. You can switch to manual mode immediately.

**OpenAI unavailable**

Voice tracking is temporarily unavailable. Your script and stage remain open.

**Quota unavailable**

OpenAI reported that this project has no available quota or billing access. Voice tracking has stopped; manual and fixed-speed modes still work.

**Rate limited**

OpenAI asked CandidCue to slow down. Voice tracking will retry after the indicated delay.

### F.15 Display failures

**Stage display disconnected**

CandidCue paused the session and kept the stage off other displays to avoid exposing your script. Reconnect the display or choose a new one.

**Stage did not open**

CandidCue could not create the prompt window on this display.

Actions: Try again · Choose another display · Open windowed preview

### F.16 Listener failures

**Listener could not play**

The script is still running without the Listener.

Actions: Use poster · Choose another · Turn off

**Not enough disk space**

Free `<amount>` and retry, or choose the smaller 720p version.

### F.17 Stop/session summary

**Heading:** Session complete

Show:

- duration;
- mode;
- sections reached;
- retakes;
- commands;
- reconnects;
- estimated OpenAI transcription cost, clearly marked as an estimate;
- transcript saved/not saved.

Actions:

- Present again
- Return to editor
- Close stage

### F.18 Privacy panel

**Local by default**

Your Markdown scripts, imported images, settings, and downloaded Listeners are stored on this device.

**While voice tracking is active**

Your selected microphone audio is sent to OpenAI for live transcription. CandidCue does not save the audio by default.

**Smart vocabulary analysis**

When enabled, unusual terms and limited surrounding context are sent to GPT-5.6 Luna. CandidCue caches the result locally.

**Ambiguous voice commands**

Most commands are handled locally. When a command is unclear, the command phrase and a compact list of script targets may be sent to GPT-5.6 Luna.

**CandidCue servers**

CandidCue checks for software updates and downloads optional Listener media. Your OpenAI API key and scripts are not sent to CandidCue servers.

**OpenAI retention**

OpenAI’s current API data controls and endpoint retention rules apply. Open the current policy for details.

### F.19 Destructive confirmations

**Delete script?**

`<title>` will move to Trash and can be restored for 30 days.

**Delete permanently?**

This removes the script, its retained revisions, and unshared local assets. This cannot be undone.

**Remove OpenAI key?**

Voice tracking and smart analysis will stop until a key is added again. Your scripts are unaffected.

**Clear all logs?**

This may make an existing issue harder to diagnose. Scripts and settings are unaffected.

---

## Appendix G — Alignment and command pseudocode

### G.1 High-level transcript update

```ts
function onTranscriptUpdate(update: ReconciledTranscriptUpdate): void {
  if (session.state === 'paused' || session.state === 'reconnecting') return;
  if (update.sessionGeneration !== session.generation) return;

  const commandResult = commandRouter.observe(update);

  if (commandResult.kind === 'pending') {
    tracking.setState('command_pending');
    tracking.maskItems(commandResult.itemIds);
    return;
  }

  if (commandResult.kind === 'command') {
    tracking.maskItems(commandResult.itemIds);
    executeValidatedCommand(commandResult.command);
    return;
  }

  const alignable = transcriptLedger.getAlignableTail({
    excludeItemIds: commandRouter.consumedItemIds(),
    maxTokens: profile.recentTranscriptMaxTokens,
  });

  const result = aligner.align({
    transcript: alignable,
    cursor: tracking.cursor,
    state: tracking.state,
    final: update.final,
    history: tracking.history,
  });

  tracking.apply(result);
  stageController.accept(tracking.toSnapshot());
}
```

### G.2 Candidate generation

```ts
function generateCandidates(input: AlignmentInput): CandidateWindow[] {
  const candidates = new CandidateSet();

  candidates.add(windowAround(
    input.cursor.committedTokenIndex,
    -profile.continuityBackTokens,
    profile.continuityForwardTokens,
    'continuity',
  ));

  candidates.add(currentParagraphRetakeWindow(input.cursor));
  candidates.add(currentSectionWindow(input.cursor));

  for (const checkpoint of input.history.recentCheckpoints()) {
    candidates.add(windowAround(checkpoint.tokenIndex, -20, 100, 'checkpoint'));
  }

  for (const anchor of findRareAnchors(input.transcript)) {
    for (const position of document.indexes.rareToken[anchor] ?? []) {
      candidates.add(windowAround(position, -40, 120, 'rare_anchor'));
    }
  }

  for (const ngram of meaningfulNgrams(input.transcript, 2, 4)) {
    for (const position of document.indexes.ngrams[ngram] ?? []) {
      candidates.add(windowAround(position, -30, 100, 'ngram'));
    }
  }

  return candidates.deduplicateAndLimit(profile.maxCandidateWindows);
}
```

### G.3 Candidate alignment and ranking

```ts
function align(input: AlignmentInput): AlignmentResult {
  const candidates = generateCandidates(input);
  const scored = candidates.map((window) => {
    const sequence = weightedBandedLocalAlignment(
      input.transcript.tokens,
      document.spokenTokens.slice(window.start, window.end),
      scoringProfile,
    );

    const absolutePosition = window.start + sequence.scriptEndOffset;
    const prior = continuityPrior({
      from: input.cursor.committedTokenIndex,
      to: absolutePosition,
      scope: window.scope,
      state: input.state,
      final: input.final,
      history: input.history,
    });

    const evidence = summarizeEvidence(sequence, input.transcript);
    const confidence = confidenceModel({
      sequenceScore: sequence.normalizedScore,
      prior,
      evidence,
      transcriptConfidence: input.transcript.confidence,
      final: input.final,
    });

    return { window, sequence, absolutePosition, prior, evidence, confidence };
  });

  scored.sort(compareCandidateScore);
  const best = scored[0];
  const second = scored[1];
  const margin = best ? best.confidence - (second?.confidence ?? 0) : 0;

  return decideTransition({ best, second, margin, input });
}
```

### G.4 Transition decision

```ts
function decideTransition(ctx: DecisionContext): AlignmentResult {
  const { best, margin, input } = ctx;
  if (!best) return hold('no_candidate');

  const distance = best.absolutePosition - input.cursor.committedTokenIndex;
  const isBackward = distance < 0;
  const isLargeForward = distance > profile.largeForwardDistance;

  if (!input.final) {
    if (best.confidence < profile.softThreshold) return hold('weak_partial');
    if (isBackward) return hold('partial_backward_forbidden');
    if (isLargeForward) return hold('partial_large_jump_forbidden');
    return provisionalAdvance(clampPartial(best));
  }

  if (isBackward) {
    if (!looksLikeRetake(best, input)) return hold('backward_not_retake');
    if (best.confidence < backwardThreshold(distance)) return retakeCandidate(best);
    if (best.evidence.contentMatches < profile.minimumBackwardContentMatches) {
      return retakeCandidate(best);
    }
    if (margin < profile.minimumBackwardMargin) return retakeCandidate(best);
    return commit(best, 'retake');
  }

  if (best.confidence >= localThreshold(distance) && margin >= requiredMargin(distance)) {
    return commit(best, isLargeForward ? 'skip' : 'advance');
  }

  if (shouldEnterGlobalSearch(input)) return search(best);
  return hold('insufficient_confidence');
}
```

### G.5 Retake detection

```ts
function looksLikeRetake(best: ScoredCandidate, input: AlignmentInput): boolean {
  const startsNearBoundary = document.isSentenceOrParagraphStart(best.absolutePosition, 3);
  const repeatedOpening = input.history.matchesPreviouslyReadOpening(
    best.absolutePosition,
    input.transcript.tokens,
  );
  const withinRecentSection = document.sameSection(
    best.absolutePosition,
    input.cursor.committedTokenIndex,
  );
  const explicitRetakeLanguage = transcriptContainsRetakeLeadIn(input.transcript);

  return (
    (startsNearBoundary && repeatedOpening && withinRecentSection) ||
    (explicitRetakeLanguage && best.confidence >= profile.softThreshold)
  );
}
```

An explicit wake-gated retake command bypasses this heuristic and supplies an authoritative target.

### G.6 Stage target

```ts
function deriveVisualTarget(snapshot: TrackingSnapshot): VisualTarget {
  const committedY = layout.tokenY(snapshot.committedTokenIndex);
  const provisionalY = layout.tokenY(snapshot.tokenIndex);

  const semanticY = snapshot.provisional
    ? clamp(
        provisionalY,
        committedY - profile.provisionalBackwardPx,
        committedY + profile.provisionalForwardPx,
      )
    : committedY;

  const leadTokens = snapshot.confidence >= profile.leadConfidence
    ? paceEstimator.leadTokens(transcriptionLatency.currentMs())
    : 0;

  const leadY = layout.tokenY(Math.min(
    snapshot.tokenIndex + leadTokens,
    layout.lastTokenIndex,
  ));

  return {
    y: Math.max(semanticY, leadY) - layout.readingBandCenterY,
    movement: snapshot.movement,
    confidence: snapshot.confidence,
  };
}
```

### G.7 Wake and command gate

```ts
function observeCommand(update: ReconciledTranscriptUpdate): CommandObservation {
  const tail = transcriptLedger.recentNormalizedTokens();
  const wake = wakeMatcher.find(tail, commandSettings.aliases);
  if (!wake) return { kind: 'none' };

  if (document.literalCommandRegionNear(tracking.cursor.tokenIndex)) {
    return { kind: 'none' };
  }

  if (wake.confidence < commandSettings.minimumWakeConfidence) {
    return { kind: 'none' };
  }

  const phrase = collectCommandPhrase(tail, wake.endIndex);
  if (!phrase.final && !looksSyntacticallyComplete(phrase)) {
    return { kind: 'pending', itemIds: phrase.itemIds };
  }

  const collision = alignCommandAsScript(wake, phrase, tracking.cursor);
  if (collision.score >= commandSettings.scriptCollisionThreshold) {
    return { kind: 'none' };
  }

  const local = deterministicCommandParser.parse(phrase.tokens, commandContext());
  if (local.confident) return validatedLocal(local, phrase);

  if (!commandSettings.lunaFallback || !looksCommandLike(phrase)) {
    return unknownCommand(phrase);
  }

  return beginLunaInterpretation(phrase, commandContext());
}
```

### G.8 Validated command execution

```ts
function executeValidatedCommand(command: ValidatedCommand): void {
  if (command.contextRevision !== currentCommandContextRevision()) return;
  if (!commandValidator.isAllowed(command.action, currentSessionState())) return;

  switch (command.action.action) {
    case 'go_to_target':
      moveToTarget(command.action.targetId, 'command');
      break;
    case 'restart_unit':
      moveToTarget(resolveRelativeRestart(command.action.unit), 'command');
      break;
    case 'pause':
      session.softPause();
      break;
    case 'hard_pause':
      session.hardPause();
      break;
    // Exhaustive switch required.
    default:
      executeNonNavigationCommand(command.action);
  }

  commandHistory.record(command);
  controlUi.acknowledge(command.humanLabel);
  stageUi.acknowledgeIfEnabled(command.humanLabel);
}
```

---
## Appendix H — Research grounding and source register

This register records the external facts that materially shaped the specification. It was verified on **24 July 2026**. APIs, models, prices, platform requirements, and vendor features can change; implementation must recheck the current official source when each integration is built and before release.

### H.1 OpenAI Realtime transcription

**Source:** [Realtime transcription — OpenAI API](https://developers.openai.com/api/docs/guides/realtime-transcription)

Verified conclusions:

- Realtime transcription sessions use `type: "transcription"` and can connect through WebSocket or WebRTC.
- `gpt-realtime-whisper` is the live streaming transcription model and emits transcript delta and completion events.
- The documented PCM input for explicit audio-buffer streaming is 24 kHz mono PCM.
- The model exposes delay settings from `minimal` through `xhigh`, with a latency/accuracy tradeoff that must be benchmarked on representative audio.
- Current `gpt-realtime-whisper` behavior omits/sets turn detection to null and requires manual audio commit.
- Completion events for different items are not guaranteed to arrive in order; reconcile with `item_id` and local chronology.
- Log probabilities can be requested when supported.
- `prompt` is not supported for `gpt-realtime-whisper` in current GA Realtime sessions.

Product consequences:

- local VAD/manual commit is a required subsystem;
- script vocabulary must improve local matching rather than being described as a Realtime custom dictionary;
- transcript items require a ledger, not naïve arrival-order concatenation;
- delay default must be selected through CandidCue’s corpus.

### H.2 Short-lived Realtime credentials

**Source:** [Create client secret — OpenAI API Reference](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create)

Verified conclusions:

- the API can create short-lived client secrets;
- the client secret can be associated with a transcription-session configuration;
- the secret is intended for client applications without exposing the permanent API key;
- TTL is configurable within the current API contract.

Product consequence: Rust stores and uses the permanent key, while the control webview receives only a short-lived transcription credential.

### H.3 WebRTC connection pattern

**Source:** [Realtime API with WebRTC — OpenAI API](https://developers.openai.com/api/docs/guides/realtime-webrtc)

Verified conclusions:

- browser clients can create an `RTCPeerConnection`, attach a microphone track, and use a data channel for Realtime events;
- with the ephemeral-token pattern, a trusted backend creates the client secret and the browser uses it to submit SDP to the Realtime calls endpoint;
- standard permanent API keys belong on the trusted backend, not in browser code.

Product consequence: the Tauri Rust process acts as the trusted backend, while browser media/WebRTC stays in the control webview.

### H.4 GPT-5.6 Luna

**Source:** [GPT-5.6 Luna model — OpenAI API](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

Verified conclusions at research cut-off:

- model ID is `gpt-5.6-luna`;
- it is positioned for cost-sensitive, high-volume workloads;
- listed standard text pricing is $1.00 per million input tokens and $6.00 per million output tokens;
- function calling/structured application workflows are supported through OpenAI’s model/API interfaces.

Product consequence: Luna is appropriate for infrequent bounded command interpretation and vocabulary classification, but is unnecessary for per-transcript alignment.

### H.5 OpenAI pricing

**Source:** [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)

Verified at research cut-off:

- `gpt-realtime-whisper`: $0.017 per audio minute;
- equivalent arithmetic: approximately $1.02 per hour of active streamed audio;
- `gpt-4o-mini-transcribe`: estimated $0.003 per minute;
- `gpt-4o-transcribe`: estimated $0.006 per minute;
- Luna token pricing as above.

Product consequence: connect only during tests/live use, explain soft versus hard pause, and label all cost displays as estimates subject to provider changes.

### H.6 Structured outputs and function calling

**Sources:**

- [Structured model outputs — OpenAI API](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Function calling — OpenAI API](https://developers.openai.com/api/docs/guides/function-calling)

Verified conclusions:

- OpenAI supports JSON-schema-constrained structured outputs;
- function calling is the intended mechanism when connecting model output to application actions;
- schema adherence does not replace application-level authorization, target existence, bounds, current-state, and stale-context validation.

Product consequence: use one strict `control_candidcue` function/schema, then validate locally before execution.

### H.7 OpenAI data controls

**Source:** [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data)

Verified at research cut-off:

- API data is not used to train OpenAI models by default according to the endpoint table;
- default abuse-monitoring logs may retain customer content for up to 30 days unless an eligible organization has approved controls;
- the current endpoint table lists `/v1/realtime` with no model-training use, 30-day abuse-monitoring retention, and no application-state retention;
- `store: false` should be used for eligible Responses requests where CandidCue does not need stored response state.

Product consequence: privacy copy must say local-first rather than fully local, link current policy, and be reverified before shipping.

### H.8 Tauri architecture

**Sources:**

- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [Tauri 2 home](https://v2.tauri.app/)

Verified conclusions:

- Tauri combines a Rust core with HTML/JavaScript rendered in system webviews;
- multiple windows/webviews communicate with native functionality through controlled message passing;
- system-webview architecture is materially lighter than bundling a full Chromium runtime, though actual app size/memory still depend on dependencies and assets.

Product consequence: use Rust for privileged operations and two small webview surfaces rather than recreating Electron’s process/dependency model.

### H.9 Tauri capabilities and CSP

**Sources:**

- [Capabilities — Tauri](https://v2.tauri.app/security/capabilities/)
- [Content Security Policy — Tauri](https://v2.tauri.app/security/csp/)

Verified conclusions:

- capabilities grant or deny permissions per window/webview;
- permissions from multiple capabilities merge, so broad shared assignments weaken separation;
- CSP is a defense against cross-site scripting and unintended content execution.

Product consequence: stage and control have separate capability files; Markdown sanitization and strict CSP remain necessary even though Tauri has a permission model.

### H.10 Tauri window behavior

**Sources:**

- [Window State plugin — Tauri](https://v2.tauri.app/plugin/window-state/)
- [Tauri Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)

Verified conclusions:

- window-state support can restore previous bounds/state;
- on macOS, `setSimpleFullscreen`/simple fullscreen avoids creating a separate macOS Space; on other platforms it maps to standard fullscreen behavior.

Product consequence: restore the control window safely and evaluate simple fullscreen for teleprompter stage behavior.

### H.11 macOS microphone permission

**Source:** [macOS application bundle — Tauri](https://v2.tauri.app/distribute/macos-application-bundle/)

Verified conclusion: WebRTC microphone access requires the appropriate `NSMicrophoneUsageDescription` in the macOS application bundle.

Product consequence: microphone permission copy is part of signed bundle configuration and must be verified in production artifacts.

### H.12 Tauri plugins, testing, signing, and updates

**Sources:**

- [Global Shortcut plugin — Tauri](https://v2.tauri.app/plugin/global-shortcut/)
- [Updater plugin — Tauri](https://v2.tauri.app/plugin/updater/)
- [WebDriver testing — Tauri](https://v2.tauri.app/develop/tests/webdriver/)
- [Tauri tests overview](https://v2.tauri.app/develop/tests/)
- [macOS code signing — Tauri](https://v2.tauri.app/distribute/sign/macos/)
- [Windows code signing — Tauri](https://v2.tauri.app/distribute/sign/windows/)
- [GitHub release pipeline — Tauri](https://v2.tauri.app/distribute/pipelines/github/)

Verified conclusions:

- global shortcuts require explicit capability permissions;
- Tauri’s updater requires signed updates and supports static or dynamic update responses;
- current Tauri guidance supports WebDriverIO/Tauri service testing across desktop platforms;
- commercial distribution requires proper macOS signing/notarization and should use Windows signing to avoid trust warnings;
- official GitHub Actions tooling can build/publish Tauri artifacts and updater metadata.

Product consequence: shortcuts remain optional; end-to-end desktop testing, signed installers, and a signed updater are release requirements.

### H.13 Markdown and diagram security

**Sources:**

- [remark repository and security guidance](https://github.com/remarkjs/remark)
- [Mermaid usage/securityLevel](https://mermaid.js.org/config/usage.html)

Verified conclusions:

- Markdown-to-HTML pipelines require sanitization to prevent XSS;
- Mermaid’s strict security mode encodes HTML and disables click functionality by default.

Product consequence: raw HTML is disabled, rendered output is sanitized, and Mermaid—if shipped—uses strict inert rendering.

### H.14 Competitive products

**Sources:**

- [VoicePrompter](https://voiceprompter.app/)
- [PromptSmart](https://promptsmart.com/)
- [Elgato Prompter](https://www.elgato.com/ww/en/p/prompter)
- [Elgato Voice Sync help](https://help.elgato.com/hc/en-us/articles/29902730928653-Camera-Hub-How-to-use-Voice-Sync)
- [Elgato Prompter system requirements](https://help.elgato.com/hc/en-us/articles/20449239934477-Elgato-Prompter-System-Requirements)
- [Speakflow](https://www.speakflow.com/)
- [Teleprompter.com](https://www.teleprompter.com/)

Grounded conclusions:

- voice-following teleprompters are an established category;
- whole-script following, pauses/ad-libs, skips, and backward behavior are already marketed by close competitors;
- second-display teleprompter hardware is a mainstream workflow;
- broader competitors add recording, remotes, cloud sync, and collaboration.

Product consequence: CandidCue should not claim that voice following itself is novel. Its product position is the refined desktop combination of whole-script tracking, Markdown/visual scripts, wake-gated control, local-first BYOK architecture, compact-display polish, and Listener mode.

### H.15 Research caveat

The sources establish API/platform capabilities and competitive claims; they do not prove CandidCue’s tracking quality. Only the Phase 0 spikes and versioned speech evaluation corpus can validate the proposed latency, retake, false-jump, and command thresholds.

---

## Appendix I — Instructions for an implementation agent

This appendix is intended for the coding model or agent receiving the specification.

### I.1 Authority order

When requirements conflict, use this order:

1. security/privacy non-negotiables;
2. canonical data/recovery guarantees;
3. voice/stage correctness and stability;
4. user-visible product behavior;
5. visual guidance from the existing Electron prototype;
6. implementation convenience.

Record a contradiction instead of silently choosing an easier behavior.

### I.2 Required workflow

For each phase:

1. Read the relevant specification sections in full.
2. Inspect the Electron prototype only for design/interaction reference.
3. Write or update an implementation checklist.
4. Add tests/fixtures before or with the subsystem.
5. Implement the smallest complete vertical slice.
6. Run type-check, lint, unit, Rust, and applicable E2E tests.
7. Verify production capability/CSP effects, not only dev mode.
8. Update an ADR for material deviations.
9. Remove dead prototype code and TODO scaffolding before marking complete.
10. Report exact acceptance evidence and remaining failures.

### I.3 Prohibited shortcuts

Do not:

- put the permanent OpenAI key in a Svelte store, local storage, or frontend environment variable;
- use `dangerouslySetInnerHTML`/raw `innerHTML` with unsanitized Markdown;
- give the stage the control capability;
- expose generic filesystem, shell, or HTTP commands;
- align by checking only the next expected word;
- call Luna for every transcript item;
- treat partial transcripts as final for large jumps;
- move stage to the primary monitor after prompt-display loss without user choice;
- store microphone audio or transcript by default;
- silently load remote images/scripts/fonts;
- ship unsigned Listener manifests or updates;
- rely on dev-browser behavior without testing the production system WebView;
- lower evaluation thresholds merely to make the build pass without documenting the product consequence;
- copy Electron IPC/runtime code into Tauri.

### I.4 Decision records required

Write an ADR before changing:

- WebRTC versus native WebSocket transport;
- frontend worker versus Rust alignment engine;
- canonical Markdown/SQLite relationship;
- raw SVG support;
- Mermaid inclusion;
- minimum OS versions;
- stage fullscreen mechanism;
- secret-store fallback;
- Listener signing/delivery;
- data sent for vocabulary analysis;
- transcript retention default;
- update/license mechanism.

### I.5 Completion report template

```markdown
## Phase/feature

### Implemented
- ...

### Files/modules
- ...

### Tests added
- ...

### Acceptance evidence
- command/output/screenshot/benchmark ...

### Security/privacy verification
- ...

### Deviations from specification
- none / ADR link and rationale

### Remaining risks
- ...
```

### I.6 No-placeholder standard

A feature is not complete with:

- mocked data in production path;
- button with no recovery state;
- hard-coded single monitor/microphone;
- unbounded array/log/cache;
- TODO around permission or error handling;
- test that only checks component existence;
- animation demonstrated only with fake fixed text;
- model response trusted without schema/domain validation.

### I.7 First implementation ticket

The first ticket should be **Phase 0A: Tauri Realtime transcription proof**, not the final UI. Required output:

- minimal signed-development Tauri build on macOS and Windows;
- key in native store;
- client-secret minting in Rust;
- selected mic WebRTC connection;
- local VAD/manual commits;
- delta/final transcript viewer;
- sanitized captured event fixtures;
- latency/reliability notes;
- go/no-go ADR for primary transport.

### I.8 Final handoff standard

A reviewer unfamiliar with the implementation should be able to:

- clone repository;
- install documented dependencies;
- run dev app;
- run tests;
- build unsigned local installers;
- understand secret/release setup without possessing secrets;
- trace a transcript item from provider event to stage movement;
- trace a script save from editor revision to canonical file/SQLite;
- inspect stage capability and confirm it cannot access the key/database;
- reproduce alignment benchmark results;
- create and verify a Listener pack;
- publish a signed release using the runbook.

---

# End of specification
