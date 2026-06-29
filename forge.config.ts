import type { ForgeConfig } from '@electron-forge/shared-types';
import { fileURLToPath } from 'node:url';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;
// `osxSign` is `true | OsxSignOptions`; isolate the options object form so the
// `optionsForFile` return type can be reused without a deep transitive import.
type OsxSignObject = Extract<NonNullable<PackagerConfig['osxSign']>, object>;
type PerFileSignOptions = ReturnType<NonNullable<OsxSignObject['optionsForFile']>>;

const ENTITLEMENTS_PATH = fileURLToPath(
  new URL('./entitlements/entitlements.darwin.plist', import.meta.url),
);

/**
 * Build the Electron Forge config. macOS code signing and notarization are
 * opt-in: they activate only when all three Apple credentials are present in
 * `env`, so a plain `npm run make` on a developer machine still produces an
 * unsigned DMG/ZIP. If only some of the three are set the build proceeds
 * unsigned with a loud warning — throwing here would break `npm start`/tests for
 * anyone who merely has a stray `APPLE_ID` exported in their shell.
 *
 * Exposed as a factory (rather than a static object) so the conditional signing
 * wiring can be unit-tested without spawning a real `make`.
 */
export function createForgeConfig(env: NodeJS.ProcessEnv = process.env): ForgeConfig {
  // Trim so a stray whitespace-only value (e.g. APPLE_ID=' ') is treated as
  // unset rather than triggering a confusing late notarization failure.
  const appleId = env.APPLE_ID?.trim() || undefined;
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD?.trim() || undefined;
  const teamId = env.APPLE_TEAM_ID?.trim() || undefined;

  const provided = [appleId, appleIdPassword, teamId].filter(Boolean).length;
  if (provided > 0 && provided < 3) {
    console.warn(
      `[forge.config] Apple signing skipped: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, ` +
        `and APPLE_TEAM_ID must all be set to produce a signed build (got ${provided}/3).`,
    );
  }

  const packagerConfig: PackagerConfig = {
    name: 'CandidCue',
    appBundleId: 'com.siteorigin.candidcue',
    // Bundled Mira media ships read-only inside the packaged app resources.
    extraResource: ['videos', 'prompts'],
    asar: true,
    // Drives NSMicrophoneUsageDescription in Info.plist so macOS shows a prompt
    // when the interview recorder requests the mic. Audio only — the app never
    // captures video (see src/main/security/permissions.ts).
    usageDescription: {
      Microphone: 'CandidCue uses the microphone to record interview audio.',
    },
  };

  if (appleId && appleIdPassword && teamId) {
    const osxSign = {
      // Custom entitlements MUST go through `optionsForFile` — @electron/osx-sign
      // ignores any top-level `entitlements` field (it only reads the per-file
      // options). The top-level app and the generic helper (which hosts the
      // audio service) get our minimal hardened-runtime plist; the GPU/Renderer/
      // Plugin helpers keep the library's correct, narrower default plists.
      optionsForFile: (filePath: string): PerFileSignOptions => {
        if (
          filePath.includes('(GPU).app') ||
          filePath.includes('(Renderer).app') ||
          filePath.includes('(Plugin).app')
        ) {
          return {};
        }
        return { entitlements: ENTITLEMENTS_PATH, hardenedRuntime: true };
      },
      // `continueOnError` is honoured by @electron/packager at runtime (mac.js)
      // but is absent from the published type, so the object is cast on assign.
      // It defaults to true, which would let a signing failure slip through as an
      // unsigned build — force it false so a bad cert fails the make.
      continueOnError: false,
    };
    packagerConfig.osxSign = osxSign as PackagerConfig['osxSign'];
    packagerConfig.osxNotarize = { appleId, appleIdPassword, teamId };
  }

  return {
    packagerConfig,
    rebuildConfig: {},
    makers: [
      new MakerSquirrel({ name: 'CandidCue' }),
      new MakerZIP({}, ['darwin']),
      new MakerDMG({}),
    ],
    plugins: [
      new VitePlugin({
        build: [
          { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
          { entry: 'src/preload/control.ts', config: 'vite.preload.config.ts', target: 'preload' },
          { entry: 'src/preload/stage.ts', config: 'vite.preload.config.ts', target: 'preload' },
        ],
        renderer: [
          { name: 'control', config: 'vite.control.config.ts' },
          { name: 'stage', config: 'vite.stage.config.ts' },
        ],
      }),
    ],
  };
}

export default createForgeConfig();
