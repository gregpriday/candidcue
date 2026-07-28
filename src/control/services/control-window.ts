/** Native full-screen for the one webview used to edit and present. */
export async function setControlFullscreen(enabled: boolean): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setFullscreen(enabled);
}
