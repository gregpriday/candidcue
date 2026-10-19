# CandidCue Privacy Policy

**Effective date:** 19 October 2026

CandidCue is a free, MIT-licensed teleprompter for the Mac. This policy
describes the CandidCue application as the project releases it; a fork or a
modified build may behave differently. The project's pages on GitHub — the
repository, its releases and its issue tracker — are run by GitHub under the
[GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).

## On your Mac

Speech recognition and following run on your Mac. CandidCue does not upload
your microphone audio or your scripts. No account, no API key, no analytics
client, no crash reporter.

## Your microphone

CandidCue opens your microphone briefly when you grant access, while a take or
a microphone test is running, and while the input meter is on screen in Audio
settings. Audio from a take or a test is held in memory and transcribed on your
Mac by the speech model installed there; it is not written to disk. The input
meter only measures how loud you are. Recognised words are used to follow your
script and are shown on screen during a microphone test or a Diagnostic Take;
they are not saved. You can turn microphone access off in System Settings ›
Privacy & Security › Microphone.

## What stays on your Mac

Your scripts and their saved revisions, imported images, settings and display
calibrations, the speech model you installed, a summary of each session (when
it ran, how long it took, and where in the script it started and stopped),
diagnostic logs, backups taken before a database upgrade, and recovery copies
of anything a save could not write or a restore or repair replaced. None of it
is sent to us, and we cannot retrieve it. Older revisions and trashed scripts
are cleared out automatically, and logs rotate. Deleting something in CandidCue
does not remove the copies kept apart from it: those backups and recovery
copies, files you exported, or what your own backup software has saved.

## The network

The speech model is downloaded when you choose to install it, from the Welcome
screen or from Speech settings. The download goes to the model's release
hosting on GitHub (`github.com`) and to whatever host that redirects it to,
such as a content delivery network, so the server that finally sends the file
is not one we can promise in advance. Like any download, it shows that server
your IP address, and its User-Agent names CandidCue and its version. It
carries none of your scripts, audio or transcripts, and the file is checked
against a SHA-256 hash built into the app before it is installed. Those
servers handle your IP address under their own privacy policies; we receive
nothing.

CandidCue also checks whether a newer version of itself is available: about
fifteen seconds after it opens and every six hours while it runs, unless you
turn off **Check for updates automatically** in Settings › Data, privacy &
updates, and whenever you choose **Check for Updates…** in the Help menu. A
check requests one small file from `updates.candidcue.com`. The request names
the version of CandidCue you are running, its release channel, and your
operating system and processor type, and, like any download, shows that server
your IP address. It carries no account, no identifier and none of your
scripts, audio or settings. The server is hosted by Cloudflare, which handles
your IP address under its own privacy policy. If you choose to install an
update, it is downloaded from the same server and installed only after it
passes a signature check built into CandidCue; nothing is installed without
your say-so, and never during a take.

An image in a script that points at a web address is not fetched. Links to web
pages, in the Help menu, the update notice or the speech model's licence, open
in your browser.

## Diagnostics

Logs are written on your Mac and are not uploaded. Support bundles are created
only when you ask for one, and go only where you send them. A bundle is
designed to leave out your scripts, your transcripts and your microphone
audio, but CandidCue cannot recognise prose in a log line, so read a bundle
before you send it to anyone.

## Your data

We hold none of the data CandidCue creates, so there is nothing for us to
access, correct or delete on your behalf. **Export all data**, in Settings ›
Data, privacy & updates, copies your scripts with their revisions and images,
your settings and the database to a folder you choose. To remove CandidCue's
data from your Mac, quit it and delete
`~/Library/Application Support/com.candidcue.app`. A few interface preferences
are kept separately in macOS's web storage for the app, and anything you
exported or saved elsewhere stays where you put it.
If you send us something — an issue, an email or a support bundle — we have
what you sent and the account or address it came from.

## Changes and contact

If a version of CandidCue changes what it does with your data or on the
network, this policy will be revised before that version is released.

Questions can go to the [issue tracker](https://github.com/gregpriday/candidcue/issues),
which is public. For anything private, use a
[private advisory](https://github.com/gregpriday/candidcue/security/advisories/new)
or email [greg@siteorigin.com](mailto:greg@siteorigin.com).
