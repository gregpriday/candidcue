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
Recognition and alignment both run on your machine. There are no accounts, no
application API keys, no telemetry, and no server backend.

The app does reach the network in one place: downloading the speech recognition
model, which is checked against a pinned digest before it is installed. That
download is the exception, not a sign that scripts or audio go anywhere else. If
you find CandidCue sending user content off the machine, that is a bug and we
want to hear about it.

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
- The speech model download path: digest verification, extraction, installation,
  sealing and resolution.
- Disclosure or modification of locally stored scripts, settings, session
  records or database contents caused by a flaw in CandidCue.
- Any transmission of audio, scripts or other user content that nobody asked
  for.

### Out of scope

- Social engineering and phishing.
- Attacks requiring physical access to an unlocked machine.
- Anything that needs an already-compromised machine, root or administrator
  control, or ordinary same-user access to files the user already owns.
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

We don't publish a PGP key at the moment, so treat mail to this address as
unencrypted in transit and send only what the report needs.

## Response and coordinated disclosure

Measured from when your email arrives:

- We'll acknowledge the report within 3 business days.
- We'll come back with an initial assessment within 7 business days.
- From there we'll agree a fix or mitigation timeline with you based on
  severity, and coordinate public disclosure as part of it.

The seven-day mark is when you hear our read on the issue, not when a fix ships.
We'd rather give you an honest timeline than a fast one we miss. If you don't
hear from us inside those windows, send a follow-up, because something has gone
wrong on our end.

## Good-faith research and safe harbour

If you make a good-faith effort to follow this policy, avoid harm and report
promptly, we will not pursue or support legal action against you over that
research. This covers claims we control. It does not authorise access to systems
or data belonging to anyone else, and it can't bind third parties.

What we ask in return:

- Only test against systems and data you own or are authorised to use.
- Use the least access needed to show the problem.
- If you hit personal or sensitive data, stop. Don't keep it and don't share it.
- Don't destroy or alter data, establish persistence, or degrade availability
  for anyone else.
- Give us a reasonable chance to investigate, and stick to the disclosure
  timeline we agree.
- If you aren't sure whether something is in scope, email and ask before you
  carry on.
