/**
 * Starter documents. The new-script example demonstrates a heading, a
 * paragraph, and a cue, and is selected so the user can immediately replace
 * it (spec §9.1.3).
 */

export const NEW_SCRIPT_TITLE = 'Untitled script';

export const NEW_SCRIPT_SOURCE = `# Your first section

Write the words you plan to say, exactly the way you would say them. When you present, the stage follows your voice and keeps your place.

[Cue: smile and hold eye contact]
`;

export const SAMPLE_SCRIPT_TITLE = 'Sample: read this aloud';

/**
 * The starter script, written to be *read out loud* rather than skimmed.
 *
 * Three deliberate choices:
 *
 * 1. It is long enough to actually exercise following — roughly ninety
 *    seconds at a natural pace. A three-line stub tells you nothing about
 *    whether the text keeps your place, which is the only question that
 *    matters on a first run.
 * 2. It uses `#` parts with `##` scenes underneath. That nesting is the shape
 *    that most often appears in real scripts, and it is the shape the section
 *    graph has to handle when a presenter reads straight through a part
 *    boundary without saying the heading aloud.
 * 3. Its content describes what to watch for while you are reading it, so the
 *    first take doubles as a tour. The sentences are written the way someone
 *    would actually say them, contractions and all — a teleprompter script
 *    that reads like prose is a script the aligner will fight you on.
 */
export const SAMPLE_SCRIPT_SOURCE = `# Getting started

## Read this part out loud

Hi. If you're reading this sentence off the screen right now, that's exactly the idea. Keep going at whatever pace feels natural to you, and watch what the text does as you speak.

You should see the line you're on stay roughly in the middle of the screen. The words behind you fade back, and the words ahead of you sit and wait. You shouldn't have to think about scrolling at all.

[Cue: relax your shoulders and look at the lens]

## Try slowing down

Now try slowing right down for a sentence or two, and put a real pause in the middle of this one — like that. The text should ease off and wait for you rather than running ahead.

Then pick the pace back up again. It should catch up smoothly, without jumping.

# What to try next

## Go off script

Say something that isn't written here at all. Talk about your day, or what you had for breakfast, for five or ten seconds, and then come back to this line and carry on reading.

That's the hard part of following a voice, and it's worth seeing how it handles it before you rely on it for anything real.

[Beat]

## Start a sentence over

Read this next sentence, stop halfway through, and then start it again from the beginning. Presenters do this constantly, and the script should follow you backwards without losing its place.

[Take: Second attempt]

# Wrapping up

That's the tour. Delete all of this and write your own words whenever you're ready — the words you plan to say, written the way you'd actually say them.

[Cue: hold still for two seconds before you stop the take]
`;
