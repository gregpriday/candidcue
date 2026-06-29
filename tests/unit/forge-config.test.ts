import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';

import { createForgeConfig } from '../../forge.config';

const FULL_ENV: NodeJS.ProcessEnv = {
  APPLE_ID: 'dev@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'TEAM123456',
};

/** The osxSign object carries a packager-only `continueOnError` plus the
 *  per-file entitlements function — neither is on the published type. */
type OsxSign = {
  continueOnError?: boolean;
  optionsForFile?: (filePath: string) => { entitlements?: string; hardenedRuntime?: boolean };
};

describe('createForgeConfig — signing gate', () => {
  it('omits osxSign/osxNotarize when no Apple credentials are set', () => {
    const config = createForgeConfig({});
    expect(config.packagerConfig?.osxSign).toBeUndefined();
    expect(config.packagerConfig?.osxNotarize).toBeUndefined();
  });

  it('wires osxSign + osxNotarize when all three credentials are present', () => {
    const config = createForgeConfig(FULL_ENV);

    const sign = config.packagerConfig?.osxSign as OsxSign;
    expect(sign).toBeTypeOf('object');
    // continueOnError must be false so a signing failure fails the make rather
    // than silently shipping unsigned (it defaults to true in @electron/packager).
    expect(sign.continueOnError).toBe(false);

    expect(config.packagerConfig?.osxNotarize).toMatchObject({
      appleId: FULL_ENV.APPLE_ID,
      appleIdPassword: FULL_ENV.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: FULL_ENV.APPLE_TEAM_ID,
    });
  });

  it('applies the custom entitlements via optionsForFile for the main bundle only', () => {
    const sign = createForgeConfig(FULL_ENV).packagerConfig?.osxSign as OsxSign;
    expect(sign.optionsForFile).toBeTypeOf('function');

    // The top-level app and the generic helper get the minimal hardened plist —
    // a top-level `entitlements` field would be silently ignored by osx-sign.
    const appOpts = sign.optionsForFile!('/build/CandidCue.app');
    expect(appOpts.entitlements).toMatch(/entitlements\.darwin\.plist$/);
    expect(appOpts.hardenedRuntime).toBe(true);

    const helperOpts = sign.optionsForFile!(
      '/build/CandidCue.app/Contents/Frameworks/CandidCue Helper.app/Contents/MacOS/CandidCue Helper',
    );
    expect(helperOpts.entitlements).toMatch(/entitlements\.darwin\.plist$/);

    // Role-specific helpers keep the library's own narrower default plists.
    for (const role of ['(GPU)', '(Renderer)', '(Plugin)']) {
      const opts = sign.optionsForFile!(`/build/CandidCue Helper ${role}.app/Contents/MacOS/x`);
      expect(opts).toEqual({});
    }
  });

  it('warns and skips signing (never throws) when credentials are partial', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = createForgeConfig({ APPLE_ID: 'dev@example.com', APPLE_TEAM_ID: 'TEAM123456' });
      expect(config.packagerConfig?.osxSign).toBeUndefined();
      expect(config.packagerConfig?.osxNotarize).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/Apple signing skipped/);
    } finally {
      warn.mockRestore();
    }
  });

  it('treats empty-string credentials as unset (no throw, no signing)', () => {
    const config = createForgeConfig({ APPLE_ID: '', APPLE_TEAM_ID: '' });
    expect(config.packagerConfig?.osxSign).toBeUndefined();
  });

  it('treats whitespace-only credentials as unset', () => {
    const config = createForgeConfig({
      APPLE_ID: '  ',
      APPLE_APP_SPECIFIC_PASSWORD: '  ',
      APPLE_TEAM_ID: '  ',
    });
    expect(config.packagerConfig?.osxSign).toBeUndefined();
    expect(config.packagerConfig?.osxNotarize).toBeUndefined();
  });
});

describe('createForgeConfig — packager + makers', () => {
  it('always declares the Microphone usage description and never Camera', () => {
    const config = createForgeConfig({});
    expect(config.packagerConfig?.usageDescription?.Microphone).toBeTruthy();
    expect(config.packagerConfig?.usageDescription?.Camera).toBeUndefined();
  });

  it('keeps the Squirrel, ZIP, and DMG makers (by identity) regardless of signing', () => {
    for (const env of [{}, FULL_ENV]) {
      const makers = createForgeConfig(env).makers ?? [];
      expect(makers).toHaveLength(3);
      expect(makers[0]).toBeInstanceOf(MakerSquirrel);
      expect(makers[1]).toBeInstanceOf(MakerZIP);
      expect(makers[2]).toBeInstanceOf(MakerDMG);
    }
  });
});

describe('entitlements.darwin.plist', () => {
  const plistPath = fileURLToPath(
    new URL('../../entitlements/entitlements.darwin.plist', import.meta.url),
  );
  const plist = readFileSync(plistPath, 'utf8');

  it('grants JIT and microphone (audio-input), each set to <true/>', () => {
    expect(plist).toMatch(
      /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/,
    );
    expect(plist).toMatch(
      /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
    );
  });

  it('does not grant camera or other unused hardware capabilities', () => {
    expect(plist).not.toContain('com.apple.security.device.camera');
    expect(plist).not.toContain('bluetooth');
    expect(plist).not.toContain('com.apple.security.device.usb');
    expect(plist).not.toContain('personal-information.location');
  });
});
