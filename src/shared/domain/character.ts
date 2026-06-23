/**
 * Hard-coded interviewer character. For the MVP, characters are defined in
 * source (registry), not in a user-editable table. A project stores only the
 * character id; the runtime resolves it into prompts, voice, media, and image.
 */
export interface InterviewerVoiceConfig {
  provider: 'inworld';
  /** Public Inworld voice id; configurable via settings override. */
  voiceId: string;
  style: 'neutral';
  speakingRate: number;
  sampleRate: number;
}

export interface InterviewerCharacter {
  id: string;
  displayName: string;
  shortDescription: string;
  /** Path relative to the videos root, e.g. "mira/profile.png". */
  profileImagePath: string;
  mediaRootPath: string;
  listeningPath: string;
  speakingPath: string;
  posterPath: string;
  voice: InterviewerVoiceConfig;
  /** Versioned persona system prompt body. */
  systemPrompt: string;
  systemPromptVersion: string;
  responseStylePrompt?: string;
  questionStrategyPrompt?: string;
  video: {
    fit: 'cover' | 'contain';
    mirrorByDefault: boolean;
    defaultZoom: number;
    defaultVerticalOffsetPercent: number;
    allowedPlaybackRate: { min: number; max: number };
  };
}

/** Public (renderer-safe) view of a character for selection UI. */
export interface PublicCharacterSummary {
  id: string;
  displayName: string;
  shortDescription: string;
  profileImageUrl: string;
}
