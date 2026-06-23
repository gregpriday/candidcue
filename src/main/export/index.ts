/**
 * Session export (spec §30). Two output formats over a single, scrubbed input
 * projection: a human-readable Markdown transcript and a portable, versioned
 * JSON envelope. Neither format carries credentials, raw audio, absolute
 * paths, or internal prompt material.
 */
export {
  buildMarkdownExport,
  resolveAnswerText,
  isIncompleteTurn,
  INTERVIEWER_DISPLAY_NAME,
} from './markdown-export';
export type { SessionExportInput } from './markdown-export';

export {
  buildJsonExport,
  PORTABLE_EXPORT_SCHEMA_VERSION,
} from './json-export';
export type {
  PortableSessionExport,
  PortableProject,
  PortableSession,
  PortableTurn,
  PortableQuestion,
  PortableAnswer,
} from './json-export';
