import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createForgeConfig } from '../../forge.config';

const FULL_ENV: NodeJS.ProcessEnv = {
  APPLE_ID: 'dev@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'TEAM123456',
};

describe('createForgeConfig — signing gate', () => {
  it('omits osxSign/osxNotarize when no Apple credentials are set', () => {
    const config = createForgeConfig({});
    expect(config.packagerConfig?.osxSign).toBeUndefined();
    expect(config.packagerConfig?.osxNotarize).toBeUndefined();
  });

  it('wires osxSign + osxNotarize when all three credentials are present', () => {
    const config = createForgeConfig(FULL_ENV);

    const sign = config.packagerConfig?.osxSign as {
      entitlements?: string;
      hardenedRuntime?: boolean;
      continueOnError?: boolean;
    };
    expect(sign).toBeTypeOf('object');
    expect(sign.hardenedRuntime).toBe(true);
    expect(sign.continueOnError).toBe(false);
    expect(sign.entitlements).toMatch(/entitlements\.darwin\.plist$/);

    expect(config.packagerConfig?.osxNotarize).toMatchObject({
      appleId: FULL_ENV.APPLE_ID,
      appleIdPassword: FULL_ENV.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: FULL_ENV.APPLE_TEAM_ID,
    });
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
});

describe('createForgeConfig — packager + makers', () => {
  it('always declares the Microphone usage description and never Camera', () => {
    const config = createForgeConfig({});
    expect(config.packagerConfig?.usageDescription?.Microphone).toBeTruthy();
    expect(config.packagerConfig?.usageDescription?.Camera).toBeUndefined();
  });

  it('keeps the Squirrel, ZIP, and DMG makers regardless of signing', () => {
    expect(createForgeConfig({}).makers).toHaveLength(3);
    expect(createForgeConfig(FULL_ENV).makers).toHaveLength(3);
  });
});

describe('entitlements.darwin.plist', () => {
  const plistPath = fileURLToPath(
    new URL('../../entitlements/entitlements.darwin.plist', import.meta.url),
  );
  const plist = readFileSync(plistPath, 'utf8');

  it('grants JIT and microphone (audio-input)', () => {
    expect(plist).toContain('com.apple.security.cs.allow-jit');
    expect(plist).toContain('com.apple.security.device.audio-input');
  });

  it('does not grant camera or other unused hardware capabilities', () => {
    expect(plist).not.toContain('com.apple.security.device.camera');
    expect(plist).not.toContain('bluetooth');
    expect(plist).not.toContain('com.apple.security.device.usb');
    expect(plist).not.toContain('personal-information.location');
  });
});
