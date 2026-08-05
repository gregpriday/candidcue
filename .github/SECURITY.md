# Security Policy

If you think you have found a security vulnerability in CandidCue, email
[security@candidcue.com](mailto:security@candidcue.com). Please don't open a
public issue for it, and please give us a chance to ship a fix before you write
it up publicly.

## Supported versions

CandidCue has one rolling release line, and security fixes land in the latest
release. There is no long-term support branch and no back-porting to older
builds.

Tell us which version you were running when you saw the problem. Checking
whether it still reproduces on the current release helps, but don't let that
hold up the report.

## Scope

CandidCue is a local desktop application. You write a script, it displays on a
second screen, and an on-device speech recogniser follows you as you read.
Recognition and alignment both run on your machine. There is no account, no
runtime API key, no analytics or crash-reporting client, and no backend of ours
for the app to talk to. Logs and session records stay on your machine unless you
export them and send them to us yourself.

Two paths do reach the network. Speech recognition models are downloaded and
checked against digests compiled into the app before they are installed, and
remote images can be fetched by the Rust core when a script pulls one in, under
its own URL and content rules. Both disclose ordinary HTTPS request metadata to
the host being contacted, including your IP address and a CandidCue User-Agent.
Neither one sends us your scripts or your audio. If you find CandidCue
transmitting user content with no clear user action behind it, that is a bug and
we want to hear about it.

### In scope

Examples rather than an exhaustive list:

- The CandidCue macOS application, its DMG, and first-party release artifacts.
- Parsing, sanitising, storing and rendering scripts, Markdown and imported
  assets.
- The boundary between the webview and Rust: command authorisation, and the
  separation between what the control window and the stage window are each
  allowed to do.
- Bypasses of the content security policy or the asset-protocol scope that reach
  script bodies, revisions, the database, logs, or anything else outside the
  intended media scope.
- Remote image fetching and decoding: URL validation, redirect handling, SSRF
  controls, content checks and storage.
- The speech model supply and loading path: archive and per-file digest
  verification, catalogue-limited extraction, staged installation,
  install-marker checks, resolution, and ONNX loading and inference.
- Unintended file reads, writes or overwrites through CandidCue, including path
  traversal and unsafe import, export or support-bundle handling.
- Disclosure or modification of locally stored scripts, settings, session
  records or database contents caused by a flaw in CandidCue.
- Unauthorised microphone activation, audio capture or retention, and any
  transmission of audio, scripts or other user content that nobody asked for.

### Out of scope

- Social engineering and phishing.
- Attacks requiring physical access to an unlocked machine.
- Anything that needs an already-compromised machine, or root or administrator
  control.
- Findings that only demonstrate access another process running as the same
  macOS user already has, without exploiting CandidCue or crossing one of its
  boundaries.
- Local denial of service and resource exhaustion with no effect on
  confidentiality, integrity or privilege boundaries.
- Vulnerabilities in third-party dependencies or services, unless the way
  CandidCue ships or uses them makes the issue exploitable here.
- Volume, destructive or availability testing against distribution
  infrastructure.

## Reporting a vulnerability

Email [security@candidcue.com](mailto:security@candidcue.com) and include what
you can:

- What the impact is, in a sentence or two.
- The CandidCue version and the macOS version you saw it on.
- What an attacker would need first, and a realistic scenario for using it.
- Steps to reproduce, or a minimal proof of concept.
- Logs or screenshots where they help. Redact scripts, recordings, database
  contents and anything personal before sending them.
- Whether you have already shared this with anyone else or published it.

Use synthetic scripts and test data where you can, and stop at the smallest
proof that establishes impact. If you can't demonstrate the issue without
sensitive material, email first and we'll sort out how to handle it.

We don't publish a PGP key at the moment. Mail to this address may not be
end-to-end encrypted, so send only what the report needs.

## Response and coordinated disclosure

Measured from when your email arrives:

- We'll acknowledge the report within 3 business days.
- We'll come back with an initial assessment within 7 business days.
- From there we'll propose a fix or mitigation timeline based on severity, and
  coordinate public disclosure with you as part of it.

The seven-day mark is when you hear our read on the issue, not when a fix ships.
We'd rather give you an honest timeline than a fast one we miss. If you don't
hear from us inside those windows, send a follow-up, because something has gone
wrong on our end.

## Good-faith research and safe harbour

If you research in good faith, substantially follow this policy, avoid harm and
report without unreasonable delay, we will not initiate legal action against you
based on that research. This covers claims we control. It does not authorise
access to systems or data belonging to anyone else, it can't bind third parties,
and it doesn't stop us meeting obligations the law puts on us.

What we ask in return:

- Only test against systems and data you own or are authorised to use.
- Use the least access needed to show the problem.
- If you hit personal or sensitive data, stop. Don't keep it and don't share it.
- Don't destroy or alter data, establish persistence, or degrade availability
  for anyone else.
- Give us a reasonable chance to investigate, and coordinate disclosure with us
  where you can. If we can't agree on timing, give us reasonable notice before
  you publish.
- If you aren't sure whether something is in scope, email and ask before you
  carry on.
