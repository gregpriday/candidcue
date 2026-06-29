import type { ForgeConfig } from '@electron-forge/shared-types';
import { fileURLToPath } from 'node:url';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';

type PackagerConfig = NonNullable<ForgeConfig['packagerConfig']>;

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
  const appleId = env.APPLE_ID;
  const appleIdPassword = env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = env.APPLE_TEAM_ID;

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
    // `continueOnError` is honoured by @electron/packager at runtime (mac.js)
    // but is absent from the published OsxSignOptions type, so the literal is
    // cast to the property type. It defaults to true, which would let a signing
    // failure slip through as an unsigned build — force it false so a bad cert
    // fails the make.
    packagerConfig.osxSign = {
      entitlements: ENTITLEMENTS_PATH,
      hardenedRuntime: true,
      continueOnError: false,
    } as PackagerConfig['osxSign'];
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
