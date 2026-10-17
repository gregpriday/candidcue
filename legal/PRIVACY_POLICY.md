# CandidCue Privacy Policy

**Effective date:** 17 October 2026

CandidCue is a free, MIT-licensed teleprompter for the Mac. This policy
covers the CandidCue application. The project's pages on GitHub — the
repository, its releases and its issue tracker — are run by GitHub under the
[GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).

## On your Mac

Speech recognition and following run on your Mac. CandidCue does not upload
your microphone audio or your scripts. No account, no API key, no analytics
client, no crash reporter.

## Your microphone

CandidCue opens your microphone briefly when you grant access, while a take or
a microphone test is running, and while the input meter is on screen in Audio
settings. Audio is held in memory and passed to the speech model installed on
your Mac; it is never written to disk. A microphone test keeps its short clip
in memory so you can play it back, and discards it when the test ends.
Recognised words are used to follow your script, or shown during a microphone
test, and are not saved.

## What stays on your Mac

Your scripts and their saved revisions, imported images, settings and display
calibrations, the speech model you installed, a summary of each session (when
it ran, how long it took, and where in the script it started and stopped),
diagnostic logs, and backups taken before a database upgrade. None of it is
sent to us, and we cannot retrieve it. Older revisions and trashed scripts are
cleared out automatically, and logs rotate. Deleting something in CandidCue
does not reach copies made outside its database: those upgrade backups,
anything you exported, or what your own backup software has saved.

## The network

The speech model is downloaded when you choose to install it, from the Welcome
screen or from Speech settings. The download goes to the model publisher's
release hosting on GitHub (`github.com`) and to whatever host that redirects
it to, such as a content delivery network, so the server that finally sends
the file is not one we can promise in advance. Like any download, it shows
that server your IP address, and its User-Agent names CandidCue and its
version. It carries none of your scripts, audio or transcripts, and the file
is checked against a SHA-256 hash built into the app before it is installed.
Those servers handle your IP address under their own privacy policies; we
receive nothing.

This version of CandidCue does not check for application updates. An image in
a script that points at a web address is not fetched. Links to web pages, in
the Help menu or the speech model's licence, open in your browser.

## Diagnostics

Logs are written on your Mac and are not uploaded. Support bundles are created
only when you ask for one, and go only where you send them. A bundle is
designed to leave out your scripts, your transcripts and your microphone
audio, but CandidCue cannot recognise prose in a log line, so read a bundle
before you send it to anyone.

## Your data

We hold none of the data CandidCue creates, so there is nothing for us to
access, correct or delete on your behalf. You manage it through CandidCue and
macOS. If you send us something — an issue, an email or a support bundle — we
hold only what you sent.

## Changes and contact

If a version of CandidCue changes what it does with your data or on the
network, an update check included, this policy will be revised before that
version is released.

Questions can go to the [issue tracker](https://github.com/gregpriday/candidcue/issues),
which is public. For anything private, use a
[private advisory](https://github.com/gregpriday/candidcue/security/advisories/new)
or email [greg@siteorigin.com](mailto:greg@siteorigin.com).
