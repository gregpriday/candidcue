import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'CandidCue',
    appBundleId: 'com.siteorigin.candidcue',
    // Bundled Mira media ships read-only inside the packaged app resources.
    extraResource: ['videos', 'prompts'],
    asar: true,
    // Signing/notarization placeholders — see docs/provider-setup.md and the
    // packaging notes. Real credentials are injected via CI secrets.
    // osxSign: {},
    // osxNotarize: {},
  },
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

export default config;
