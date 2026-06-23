import type { InterviewerCharacter, PublicCharacterSummary } from '@shared/domain';
import { loadPrompt } from '../prompts/prompt-loader';
import { MIRA_RESPONSE_STYLE_PROMPT, MIRA_QUESTION_STRATEGY_PROMPT } from './mira/prompts';

/**
 * Hard-coded interviewer characters (spec appendix D). The persona system
 * prompt body and version are loaded from the versioned prompt file so there
 * is a single source of truth. Adding a character later requires only a new
 * media folder, profile image, prompts, and an entry here — no DB migration.
 */
function buildMira(): InterviewerCharacter {
  let systemPrompt = '';
  let systemPromptVersion = '0.0.0';
  try {
    const loaded = loadPrompt('mira.system');
    systemPrompt = loaded.body;
    systemPromptVersion = loaded.meta.version;
  } catch {
    // Prompts root may not be set in some test contexts; leave empty.
  }
  return {
    id: 'mira',
    displayName: 'Mira',
    shortDescription: 'Warm, curious, focused interviewer for conversational video content.',
    profileImagePath: 'mira/profile.png',
    mediaRootPath: 'mira',
    listeningPath: 'mira/listening',
    speakingPath: 'mira/speaking',
    posterPath: 'mira/poster.webp',
    voice: {
      provider: 'inworld',
      voiceId: 'default-vjmruianb0v3isz0fhtnig__design-voice-99088bb6',
      style: 'neutral',
      speakingRate: 1.0,
      sampleRate: 24000,
    },
    systemPrompt,
    systemPromptVersion,
    responseStylePrompt: MIRA_RESPONSE_STYLE_PROMPT,
    questionStrategyPrompt: MIRA_QUESTION_STRATEGY_PROMPT,
    video: {
      fit: 'cover',
      mirrorByDefault: false,
      defaultZoom: 1.0,
      defaultVerticalOffsetPercent: 0,
      allowedPlaybackRate: { min: 0.92, max: 1.08 },
    },
  };
}

let cache: InterviewerCharacter[] | null = null;

export function getInterviewerCharacters(): InterviewerCharacter[] {
  if (!cache) cache = [buildMira()];
  return cache;
}

export function getInterviewerCharacter(id: string): InterviewerCharacter | undefined {
  return getInterviewerCharacters().find((c) => c.id === id);
}

/** Compose the full interviewer system prompt (global rules + persona + style). */
export function composeCharacterSystemPrompt(
  character: InterviewerCharacter,
  globalRules: string,
): string {
  return [
    globalRules.trim(),
    character.systemPrompt.trim(),
    character.responseStylePrompt?.trim() ?? '',
    character.questionStrategyPrompt?.trim() ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function toPublicCharacterSummary(
  character: InterviewerCharacter,
  profileImageUrl: string,
): PublicCharacterSummary {
  return {
    id: character.id,
    displayName: character.displayName,
    shortDescription: character.shortDescription,
    profileImageUrl,
  };
}

/** Reset the in-memory cache (used after prompts root changes / in tests). */
export function resetCharacterCache(): void {
  cache = null;
}
