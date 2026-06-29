import {
  buildAdapters,
  buildFakeAdapters,
  useFakeProviders,
  hasProviderCredential,
  getProviderCredential,
  FAKE_PROVIDER_KEY,
} from '@main/providers/factory';
import { FakeInterviewModel, FakeModeration, FakeStt, FakeTts } from '@main/providers/fakes';

// The provider seam lets an app-level launch test point the real Electron app at
// the deterministic fakes via CANDIDCUE_PROVIDERS=fake. It MUST stay inert in
// production: with the env var unset, real adapters are built and the credential
// helpers consult the real key store. These tests lock that property down — a
// regression that made fakes the default (or satisfied the auth gate without a
// stored key) would be caught here. There is no CI on this repo, so this is the
// backstop for the security-sensitive seam.

const ENV_KEY = 'CANDIDCUE_PROVIDERS';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

function setFake(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
}

const emptyStore = { hasKey: () => false, getKey: () => null };
const fullStore = { hasKey: () => true, getKey: () => 'real-key' };

describe('provider seam (CANDIDCUE_PROVIDERS)', () => {
  describe('useFakeProviders', () => {
    it('is false when the env var is unset', () => {
      setFake(undefined);
      expect(useFakeProviders()).toBe(false);
    });

    it('is true only for the exact value "fake"', () => {
      setFake('fake');
      expect(useFakeProviders()).toBe(true);
    });

    it('is false for any other value', () => {
      setFake('true');
      expect(useFakeProviders()).toBe(false);
      setFake('1');
      expect(useFakeProviders()).toBe(false);
      setFake('Fake');
      expect(useFakeProviders()).toBe(false);
    });
  });

  describe('buildAdapters', () => {
    it('returns the deterministic fakes in fake mode', () => {
      setFake('fake');
      const a = buildAdapters({ openaiKey: '', inworldKey: '' });
      expect(a.model).toBeInstanceOf(FakeInterviewModel);
      expect(a.moderation).toBeInstanceOf(FakeModeration);
      expect(a.stt).toBeInstanceOf(FakeStt);
      expect(a.tts).toBeInstanceOf(FakeTts);
    });

    it('returns real (non-fake) adapters when the env var is unset', () => {
      setFake(undefined);
      // Real adapter construction is lazy (no network at build time); dummy keys
      // are enough to confirm the seam does NOT substitute fakes in production.
      const a = buildAdapters({ openaiKey: 'sk-test-dummy', inworldKey: 'dummy-key' });
      expect(a.model).not.toBeInstanceOf(FakeInterviewModel);
      expect(a.moderation).not.toBeInstanceOf(FakeModeration);
      expect(a.stt).not.toBeInstanceOf(FakeStt);
      expect(a.tts).not.toBeInstanceOf(FakeTts);
    });
  });

  describe('buildFakeAdapters', () => {
    it('builds a fresh fake set on every call (no shared mutable state)', () => {
      // Two concurrent fake sessions must not share FakeStt.currentTurnId /
      // FakeTts.seen state, so every build returns distinct instances.
      const a = buildFakeAdapters();
      const b = buildFakeAdapters();
      expect(a.model).not.toBe(b.model);
      expect(a.stt).not.toBe(b.stt);
      expect(a.tts).not.toBe(b.tts);
    });
  });

  describe('hasProviderCredential', () => {
    it('short-circuits to true in fake mode regardless of the store', () => {
      setFake('fake');
      expect(hasProviderCredential('openai', emptyStore)).toBe(true);
      expect(hasProviderCredential('inworld', emptyStore)).toBe(true);
    });

    it('consults the store in real mode', () => {
      setFake(undefined);
      expect(hasProviderCredential('openai', emptyStore)).toBe(false);
      expect(hasProviderCredential('openai', fullStore)).toBe(true);
    });
  });

  describe('getProviderCredential', () => {
    it('returns the stand-in key in fake mode', () => {
      setFake('fake');
      expect(getProviderCredential('openai', emptyStore)).toBe(FAKE_PROVIDER_KEY);
      expect(getProviderCredential('inworld', emptyStore)).toBe(FAKE_PROVIDER_KEY);
    });

    it('returns the stored key (or null when absent) in real mode', () => {
      setFake(undefined);
      expect(getProviderCredential('openai', fullStore)).toBe('real-key');
      expect(getProviderCredential('openai', emptyStore)).toBeNull();
    });
  });
});
