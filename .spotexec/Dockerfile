# Project container for spotexec: every `sx` command, and the [deps] install,
# runs in this image on the runner. The worktree is mounted at run time and
# node_modules comes from the [deps] cache, so this holds tools only.
#
#   spotexec container build
#
# Commands run as the runner's non-root user with HOME=/home/spotexec mounted
# per slot: install toolchains system-wide, never under /root or
# /home/spotexec, where the mount would hide them. The image is rebuilt only
# when this file changes.
#
# It mirrors CI's `linux` job (.github/workflows/ci.yml), on Debian 12 rather
# than Ubuntu 22.04: both ship WebKitGTK 4.1.

# .nvmrc pins Node; keep the two equal.
FROM node:26.4.0-bookworm

# GitHub's Linux runners use C.UTF-8; Debian images default to POSIX.
ENV LANG=C.UTF-8 \
    npm_config_update_notifier=false

# What Tauri 2 needs to compile on Linux: the same list as CI's "Install the
# WebKitGTK build dependencies" step, less the AppImage bundler's tools
# (`xdg-utils`, `patchelf`), since nothing here bundles. Then the tools test
# suites probe for.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential pkg-config file \
      libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev librsvg2-dev \
      bzip2 ca-certificates curl git jq lsof procps unzip xz-utils zstd \
 && rm -rf /var/lib/apt/lists/*

# pnpm, pinned from package.json "packageManager".
RUN npm install -g pnpm@10.29.2 && npm cache clean --force

# Rust, pinned to rust-toolchain.toml's exact release, with its components and
# its two Apple targets: rustup installs whatever that file names on first use,
# and RUSTUP_HOME is read-only to the runner's user, so everything it names
# must already be here. CARGO_HOME is left unset at run time, so the registry
# and git caches land in the slot's persistent $HOME/.cargo.
ENV RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL --retry 5 --retry-all-errors https://sh.rustup.rs \
      | CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path --profile minimal \
          --default-toolchain 1.97.0 \
          --component clippy --component rustfmt \
          --target aarch64-apple-darwin --target x86_64-apple-darwin \
 && chmod -R a+rX /usr/local/rustup /usr/local/cargo \
 && rustc --version && cargo clippy --version

# The system libraries Playwright's Chromium needs: playwright.config.ts runs
# Desktop Chrome only (Safari is opt-in). The browser itself is fetched per slot
# by the e2e task at the version the lockfile pins, so a Playwright bump never
# needs this image rebuilt.
RUN npx -y playwright@1.61.1 install-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
