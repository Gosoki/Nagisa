/**
 * Public entry point for the interface overlay.
 *
 * `main.ts` (outside this directory) calls `mountOverlay(target)` once, after the WebGL
 * canvas exists, and holds onto the returned handle for the lifetime of the page. Using
 * Svelte 5's `mount`/`unmount` functions directly — rather than `new Overlay(...)`, the
 * Svelte 4 class API — keeps this aligned with the rest of the client, which is runes-only.
 */
import { mount, unmount } from 'svelte';
import Overlay from './Overlay.svelte';

export function mountOverlay(target: HTMLElement): { destroy(): void } {
  const instance = mount(Overlay, { target });

  return {
    destroy(): void {
      unmount(instance);
    },
  };
}
