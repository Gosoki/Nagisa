/**
 * Settings — the player's own preferences, kept in `localStorage`.
 *
 * Split out of `stores.ts` so that `i18n/` can depend on the language setting without a
 * module cycle (`stores.ts` uses the translator for its notices).
 */

import { writable, type Writable } from 'svelte/store';
import type { QualityTier } from '../engine/quality.js';

/** Interface languages. Kept here (not in `i18n/`) so this module has no dependencies. */
export type Lang = 'zh' | 'ja' | 'en';

function detectLang(): Lang {
  const prefs = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const raw of prefs) {
    const tag = String(raw ?? '').toLowerCase();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

export interface Settings {
  quality: QualityTier;
  /**
   * Whether `quality` is the person's own pick. A pick is kept from load to load; a detected
   * tier is detected afresh every time, so settings carried to a weaker device do not carry
   * the stronger one's guess with them.
   */
  qualityChosen: boolean;
  /** Interface language. Defaults to the browser's. */
  lang: Lang;
  /** Master audio mute. Audio starts muted until the first gesture — browsers require it. */
  muted: boolean;
  /** Show name tags above other players. */
  showNames: boolean;
  /** Show the minimap. On by default — it is the only way to find people. */
  minimap: boolean;
  /** Show the performance readout. Off by default; toggled with a keyboard shortcut. */
  showStats: boolean;
  /** Reduce motion: stills the camera drift and shortens transitions. */
  reducedMotion: boolean;
  /**
   * Draw the medium: pen hatching in the shade and paper tooth over everything.
   *
   * Both are screen-space, so they belong to the picture rather than to the surfaces —
   * which is the point of them and also why they slide as you walk. On by default;
   * off gives flat fills and lines only.
   */
  paperTexture: boolean;
}

const SETTINGS_KEY = 'nagisa.settings';

/** Load persisted settings, falling back to sensible defaults. */
function loadSettings(): Settings {
  const defaults: Settings = {
    quality: 'high',
    qualityChosen: false,
    lang: detectLang(),
    muted: true,
    showNames: true,
    minimap: true,
    showStats: false,
    reducedMotion:
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    paperTexture: true,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const merged = raw ? { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) } : defaults;
    // A value written by a build that spoke a language this one does not.
    if (merged.lang !== 'zh' && merged.lang !== 'ja' && merged.lang !== 'en') merged.lang = defaults.lang;
    if (merged.quality !== 'low' && merged.quality !== 'medium' && merged.quality !== 'high') {
      merged.quality = defaults.quality;
      merged.qualityChosen = false;
    }
    return merged;
  } catch {
    return defaults;
  }
}

export const settings: Writable<Settings> = writable(loadSettings());

// Persist on every change. Cheap, and it means quality choices survive a reload.
settings.subscribe((value) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  } catch {
    /* Private mode: settings are session-only. */
  }
});

