/**
 * The application version, as the frontend sees it.
 *
 * GENERATED — `pnpm version:set <version>` rewrites `APP_VERSION` here together
 * with `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`,
 * and `pnpm version:check` fails when any of the four disagree.
 *
 * Rust remains the authority at runtime: `app_version` reports what the SIGNED
 * BUNDLE actually says, which is the number a support request needs. This
 * constant is the fallback for the two situations where there is no Rust to
 * ask — plain-browser dev, and a backend that failed to come up — and it exists
 * so that neither situation invents a number. Two hard-coded `0.1.0` literals
 * used to sit in `settings.ts` doing this job; they survived three version
 * bumps that never reached them.
 */
export const APP_VERSION = '0.1.0';

/**
 * What to show when the answer is "this is not a real build".
 *
 * Deliberately not equal to `APP_VERSION`: a diagnostics paste reading
 * `1.0.0-rc.1` when the reporter was in a browser tab would send an
 * investigation after a bundle that was never running.
 */
export const DEV_APP_VERSION = `${APP_VERSION}-dev`;
