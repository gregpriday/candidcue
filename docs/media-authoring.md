# Mira Media Authoring

CandidCue plays pre-rendered interviewer clips. Mira's media lives under:

```
videos/mira/
├── character.json     # voice + video config
├── profile.png        # selection-UI image
├── poster.webp        # fallback still
├── listening/         # loop clips while the user speaks / Mira thinks
├── speaking/          # generic mouth/body movement, paired with TTS audio
└── manifest.json      # generated — do not hand-edit
```

## Clip requirements

For smooth playback, all clips should share:

- the same resolution, aspect ratio, colour profile, and frame rate;
- a Chromium-compatible codec/container (H.264 in MP4 works well);
- **no audio track** (speaking clips are paired with separately generated TTS);
- visually similar neutral start/end frames;
- a stable face and eye line;
- frequent keyframes for responsive starts.

Provide a spread of **speaking** clip durations (e.g. 4s–15s in ~1s steps) so the
planner can fit a clip to any generated question's audio length by nudging the
playback rate within ±8% (`character.json` `allowedPlaybackRate`). The bundled
set spans 4s–15s. Listening clips can be a few longer loops.

## Indexing and validation

After adding or changing clips, regenerate the manifest:

```bash
npm run media:index      # probes durations/dims with ffprobe → manifest.json
npm run media:validate   # fails the build on missing folders, undecodable
                         # clips, zero durations, or embedded audio
```

`media:validate` runs as part of `npm run verify`. It errors on hard problems
(missing files, embedded audio, no listening/speaking clips) and warns on softer
issues (inconsistent dimensions/fps, clips outside the 4–15s sweet spot).

## Adding a new interviewer later

Adding a bundled character requires only: a new `videos/<id>/` media folder, a
profile image, prompts, and a character definition in
`src/main/characters/`. No database migration is needed.
