# CandidCue Privacy Policy

**Effective date:** @@LEGAL_EFFECTIVE_DATE@@
**Canonical version:** @@LEGAL_WEBSITE_ORIGIN@@/legal/privacy

This policy describes what happens to your data when you use the CandidCue
application and when you visit @@LEGAL_WEBSITE_ORIGIN@@.

It describes CandidCue as it behaves in the version this policy ships with. If a
future version changes what CandidCue does on the network, this policy will be
revised before that version is released.

**Controller:** @@LEGAL_CONTROLLER_NAME@@, @@LEGAL_BUSINESS_ADDRESS@@.
**Privacy contact:** @@LEGAL_PRIVACY_EMAIL@@.

---

## The short version

The CandidCue app does not send us your scripts, your microphone audio, your
transcripts, usage analytics or crash reports. Speech recognition and script
following happen on your own machine. There is no account and no API key.

The website is a different thing. Like every web server, it records IP
addresses in its logs, and if you buy CandidCue, our Merchant of Record handles
your payment. Those are covered further down.

---

# Part 1 — The application

## What CandidCue stores, and where

Everything CandidCue creates is stored on your own device, under your user
account. We do not receive it, and we cannot retrieve it.

**Your work**

- The Markdown source of your scripts, their titles and metadata, and a
  plain-text index used for searching them.
- Revision snapshots of your scripts, so you can go back.
- Images you import into a script, together with metadata such as the original
  filename.
- Custom pronunciation and dictionary entries you add.

**Your settings and setup**

- Application, editor, speech, following, display and audio preferences.
- Display fingerprints and saved stage and optical-calibration profiles, so
  CandidCue can recognise your second screen and remember how it was set up.
- A small amount of per-machine state kept by the application's own window
  storage, including the identifier and label of the microphone you last chose
  and whether microphone permission had previously been granted.

**Your session history**

- For each take: timestamps, mode, a hash of the script, positions reached,
  durations, pause, retake and correction counts, tracking measurements,
  sections and checkpoints reached, and confidence summaries.
- Recognised transcript text **only if transcript retention is turned on.** It
  is off by default — see below.

**Technical files**

- Diagnostic and crash logs written locally as CandidCue runs.
- The SQLite database itself, its write-ahead log, and up to five automatic
  backups taken before a database migration.
- The speech recognition model you installed, with its attribution files.
- Temporary copies made while deleting things safely, and any files you
  explicitly export.

## Transcript retention is off by default

CandidCue does not keep a transcript of what you said unless transcript
retention is switched on. The default is **off**, and with it off the recognised
text is used to follow your script and then discarded rather than written to the
database.

The setting supports keeping transcripts for 1 day, 7 days, 30 days, or
indefinitely. Turning it off removes transcripts that were already kept.

This setting is not currently exposed in the application's settings screens. In
this version it is effectively always off unless it has been changed outside the
application.

Session and take records — the timings, counts and measurements listed above —
are stored separately and are kept regardless of this setting. They do not
contain what you said.

## When your microphone is open

CandidCue opens your microphone:

- briefly, when you first grant access;
- while a take or a microphone test is running;
- while the input meter is on screen in Audio settings.

That last one matters and is easy to miss: the meter holds an open capture for
as long as that screen is showing and permission is granted, not just while you
are recording.

Audio from a take or a test is transcribed on your machine by the speech model
installed there. The meter only measures how loud you are; it does not transcribe
anything.

**Audio from a take is never written to disk and never leaves your machine.** It
is held in memory, passed to the on-device recogniser, and discarded. The one
narrow exception is the microphone test, which holds a short clip in memory so
you can play back what you just said; that clip is discarded when the test ends
and is never written to disk either.

## How following works

Speech recognition runs locally against the model installed on your machine.
Deciding where in your script you are, and scrolling the stage to match, is
arithmetic performed on your machine. There is no transcription service, no API
key and no third party involved in following you.

## What CandidCue does on the network

CandidCue makes no background network requests. It does not check for updates on
its own, and this version has no update service to check with. There is no
telemetry, no analytics, no advertising, no crash reporting upload, and no
licence check — CandidCue does not verify a registration, because there is
nothing for it to verify.

The network request this version makes is one you start: **downloading a speech
recognition language from Speech settings.** That download:

- goes to the model publisher's own release hosting, which is GitHub. The exact
  source is shown in the application before you start;
- is verified against a SHA-256 hash recorded in the application, so a
  substituted file is rejected;
- may involve more than one HTTP request, because a download can be redirected
  or resumed after an interruption;
- carries **none of your script, audio or transcripts.** It is a request for a
  file.

Like any download, that request tells GitHub your IP address. GitHub handles
that under its own privacy policy; we receive nothing about it, and CandidCue
does not record that the download happened beyond what is needed to install and
verify the model.

Links in the application that point to third-party pages — such as the licence
for the speech model — open in your browser and are governed by those sites'
own policies.

## Diagnostic logs

CandidCue writes diagnostic logs locally while it runs. They are kept on your
machine, rotated automatically, and **not uploaded.** Nothing sends them
anywhere unless you choose to export them and send them to us yourself.

They record technical events — operations, timings, identifiers, file paths,
counts and errors. Script text is not deliberately logged, but the logging layer
does not technically guarantee that no fragment of content ever appears in an
error message. If you send us a log, please have a look at it first.

## How long the app keeps things

CandidCue keeps your scripts, settings and session history until you delete
them. Some things are trimmed automatically:

- **Script revisions:** everything from the last 24 hours, then one per day for
  30 days, then one per week, up to 100 revisions per script.
- **Trashed scripts:** purged 30 days after you move them to the trash.
- **Database backups:** the five most recent pre-migration backups.
- **Logs:** rotated, with a limited number of recent daily files retained.
- **Transcripts:** per the retention setting above; off by default.

Deleting the application's data directory removes all of it. Because none of it
exists anywhere else, deleting it is permanent.

---

# Part 2 — The website and buying CandidCue

This part covers @@LEGAL_WEBSITE_ORIGIN@@ and the purchase process. Unlike the
application, this part does involve processing your personal data, and
@@LEGAL_CONTROLLER_NAME@@ is the controller for it.

## Server logs

Our web host records ordinary server-log information when you visit, including
your IP address, the time of the request, the page requested, the referring page
and your browser's user-agent string. Every web server does this, and it is how
the site is kept available and secure.

- **Purpose:** operating the site, diagnosing faults, and detecting abuse.
- **Lawful basis:** our legitimate interests in running and securing the site
  (GDPR Article 6(1)(f)).
- **Retention:** @@LEGAL_WEB_LOG_RETENTION@@.
- **Host:** @@LEGAL_WEB_HOST_NAME@@.

@@LEGAL_WEBSITE_ANALYTICS_STATEMENT@@

## Buying CandidCue

Payment is handled by our Merchant of Record, @@LEGAL_MOR_NAME@@. When you buy
CandidCue you enter into a purchase with them as the seller of record. They
collect and process your payment details, billing address and tax information,
and they are an **independent controller** for that data. We never see or hold
your card details.

See their privacy policy at @@LEGAL_MOR_PRIVACY_URL@@ for how they handle it.

@@LEGAL_MOR_NAME@@ passes back to us a limited set of order information —
@@LEGAL_MOR_FIELDS_RETURNED@@ — so that we can recognise your purchase, provide
support and handle refunds.

- **Purpose:** fulfilling and supporting your purchase, and meeting our tax and
  accounting obligations.
- **Lawful basis:** performance of a contract with you (Article 6(1)(b)) and
  compliance with a legal obligation (Article 6(1)(c)) for records we must keep.
- **Retention:** @@LEGAL_ORDER_RETENTION@@.

Registering CandidCue creates no account and produces no licence key. There is
nothing to log in to.

## If you contact us

If you email us for support, we hold your message and our reply so we can help
you and refer back to it.

- **Lawful basis:** our legitimate interest in answering people who contact us,
  and performance of a contract where the enquiry concerns a purchase.
- **Retention:** @@LEGAL_SUPPORT_RETENTION@@.

## International transfers

Our host and our Merchant of Record may process data outside your country,
including outside the EEA and the UK. Where they do, transfers are made under
appropriate safeguards: @@LEGAL_TRANSFER_SAFEGUARDS@@.

---

# Part 3 — Your rights

Where the GDPR or the UK GDPR applies to you, you have the right to:

- **access** the personal data we hold about you;
- **rectify** it if it is inaccurate or incomplete;
- **erase** it, in the circumstances the law provides;
- **restrict** how we process it;
- **portability** — receive it in a machine-readable format, or have it
  transferred;
- **object** to processing carried out on the basis of legitimate interests;
- **complain** to your data protection supervisory authority. In the EU that is
  the authority in your country of residence; in the UK it is the Information
  Commissioner's Office.

To exercise any of these, email @@LEGAL_PRIVACY_EMAIL@@. We will respond within
the time the law allows.

**One important limit.** These rights apply to data we actually hold — website
logs, order information and correspondence. They cannot apply to what is inside
the application on your machine: your scripts, your session history and your
transcripts never reach us, so there is nothing for us to produce, correct or
erase. That data is under your control, and deleting it is something you do on
your own device.

If you bought through @@LEGAL_MOR_NAME@@ and your request concerns payment data,
you may need to direct it to them as the controller for that data.

---

# Part 4 — Security and changes

**Security.** Application data stays on your device and is protected by your
operating system's own user account and file permissions. CandidCue restricts
its own file access so that script bodies, revisions, the database, backups and
logs are not reachable through the application's asset-loading layer. On the
website and payment side, we rely on our host and our Merchant of Record, both of
whom we expect to maintain appropriate technical and organisational measures.

**Changes to this policy.** If we change what we collect or how we handle it, we
will update this policy and change the effective date at the top. If a future
version of CandidCue introduces any new network activity — an update check, for
example — this policy will be revised to describe it before that version is
released.

**Contact.** @@LEGAL_CONTROLLER_NAME@@, @@LEGAL_BUSINESS_ADDRESS@@ —
@@LEGAL_PRIVACY_EMAIL@@.

Related: [End User Licence Agreement](EULA.md) · [Refund Policy](REFUND_POLICY.md)
