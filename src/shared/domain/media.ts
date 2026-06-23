export type MediaMode = 'listening' | 'speaking';

export interface MediaClip {
  id: string;
  relativePath: string;
  mode: MediaMode;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  container: string;
  hasAudio: boolean;
  fileSizeBytes: number;
  sha256: string;
  enabled: boolean;
  tags: string[];
}

export interface CharacterMediaManifest {
  schemaVersion: 1;
  characterId: string;
  generatedAt: string;
  sourceRootHash: string;
  clips: MediaClip[];
}

export interface MediaValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  clipId?: string;
  relativePath?: string;
}

export interface MediaValidationResult {
  ok: boolean;
  errors: MediaValidationIssue[];
  warnings: MediaValidationIssue[];
  listeningCount: number;
  speakingCount: number;
}
