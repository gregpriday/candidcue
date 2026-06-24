import type { CandidCueControlApi, CandidCueStageApi } from '@shared/contracts';

declare global {
  interface Window {
    candidcue: CandidCueControlApi;
    candidcueStage: CandidCueStageApi;
  }

  // Vite injects these at build time (vite/client is not in tsconfig types).
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly MODE: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  // AudioWorklet globals (not in the standard DOM lib) for pcm-worklet.ts.
  class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor();
  }
  function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;
  const sampleRate: number;
  const currentTime: number;
}

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
declare module '*.css';

declare module '*.svg' {
  const content: string;
  export default content;
}

export {};
