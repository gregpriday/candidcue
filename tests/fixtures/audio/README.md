# Audio fixtures

## `quarterly-update-24k-mono.wav`

Synthetic speech, PCM signed 16-bit little-endian, 24 kHz, mono — the exact
format the fixture corpora were captured at. 9.36 s.

Spoken text, which is what a test asserts against:

> Good morning everyone, and welcome to the quarterly update. Revenue is up
> fifteen percent against a plan that expected only nine.

Generated with fal.ai `fal-ai/gemini-3.1-flash-tts` and converted with
`ffmpeg -ac 1 -ar 24000 -c:a pcm_s16le`. Committed rather than generated at
test time on purpose: a fixture that regenerates is a fixture whose failures
can be the generator's, and the point of this one is to be the KNOWN-GOOD
input — when a transcription test fails, the audio must not be a suspect.

It is synthetic rather than a recording so it can be committed without anyone's
voice in the repository, and so the expected words are exact.
