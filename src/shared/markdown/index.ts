/**
 * CandidCue Markdown compiler package (spec §22-§25). Pure TypeScript:
 * usable from the compiler worker, tests, and (sparingly) the UI thread.
 */
export { compile, COMPILER_VERSION, SCHEMA_VERSION, DEFAULT_WORDS_PER_MINUTE } from './compile';
export { hashString, shortHash } from './hash';
export {
  standardizeText,
  normalizeToken,
  normalizePhrase,
  numberToWords,
  ABBREVIATION_ALIASES,
} from './normalize';
export { tokenizeText, type RawToken } from './tokenize';
export { segmentSentences, type SentenceRange } from './segment';
export {
  deriveParts,
  flattenOutlineNodes,
  partAt,
  nextPart,
  type DerivePartsInput,
} from './parts';
export {
  scanContainers,
  containerAt,
  ContainerIndex,
  resolveContainerSemantics,
  classifyBracketDirective,
  type ContainerKind,
  type ContainerRegion,
  type ContainerScanResult,
  type ContainerSemantics,
  type InlineDirective,
} from './directives';
export type {
  CompilerWorkerRequest,
  CompilerWorkerResponse,
  CompileRequestMessage,
  CancelRequestMessage,
  CompileResultMessage,
  CompileSupersededMessage,
  CompileErrorMessage,
} from './worker-protocol';
