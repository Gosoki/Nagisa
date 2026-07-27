/**
 * Nagisa design tokens.
 * =====================
 *
 * One palette for both halves of the product: the DOM overlay and the 3D scene read
 * from the same values, so the UI never looks pasted on top of the world.
 *
 * The rules the palette encodes, taken from the reference product:
 *
 * - **Paper, not glass.** Surfaces are warm off-white with a soft shadow, not frosted
 *   translucency. Translucency competes with the scene; paper sits on it.
 * - **One accent, used rarely.** Vermilion appears on the torii, the lighthouse band,
 *   and *one* interactive affordance at a time. If two things are red, neither is.
 * - **Ink, not black.** Text is warm near-black; pure #000 reads as a game HUD.
 * - **The UI is never the brightest thing on screen.** Overlay surfaces sit slightly
 *   below the sky's luminance so the eye goes to the world first.
 */

/** Interface palette. CSS-ready strings. */
export const UI_COLORS = {
  /** Primary surface: warm paper. */
  surface: '#F6F2EA',
  /** Recessed surface, for grouped rows inside a panel. */
  surfaceSunk: '#EDE7DC',
  /** Raised surface, for the one element that should feel touchable. */
  surfaceRaised: '#FFFDF8',

  /** Primary text: sumi ink, warm. */
  ink: '#26221E',
  /** Secondary text: labels, timestamps, counts. */
  inkMuted: '#6B635A',
  /** Tertiary: hints that should be legible but not read. */
  inkFaint: '#A79D91',

  /** The single accent. Torii vermilion. */
  accent: '#C4503A',
  /** Accent at rest, for borders and underlines. */
  accentSoft: '#E8C4BA',

  /** Sea, used for the "you are here" marker and the audience-mode badge. */
  sea: '#4E7C8C',
  /** Positive state: live activity, successful check-in. */
  live: '#5E8C61',
  /** Warning state: connection trouble. Deliberately dull — never alarming. */
  warn: '#B98C4A',

  /** Hairline separators. */
  line: 'rgba(38, 34, 30, 0.12)',
  /** Panel shadow. Long and soft, like paper resting on a table. */
  shadow: '0 2px 18px rgba(38, 34, 30, 0.14)',
  /** Scrim behind the entry screen only. */
  scrim: 'rgba(246, 242, 234, 0.86)',
} as const;

/** Scene palette. Hex numbers, ready for `new THREE.Color()`. */
export const SCENE_COLORS = {
  /** Sky gradient, horizon → zenith. */
  skyHorizon: 0xf2e6d4,
  skyZenith: 0x8fb8d4,

  /** Sun and its bounce, driving the two-tone toon ramp. */
  sunLight: 0xfff2dc,
  ambientLight: 0xa8c0d0,
  /** Fill from below: light bouncing off the sea. */
  bounceLight: 0x6f98ac,

  /** Water: shallow at the shore, deep offshore. */
  waterShallow: 0x74b3bd,
  waterDeep: 0x2c5f7a,
  waterFoam: 0xf4f8f6,

  /** Ground. */
  sand: 0xe4d5b7,
  grass: 0x7d9a5e,
  grassDry: 0xa3ab6a,
  rock: 0x8b8378,
  cliff: 0x6f6a62,
  path: 0xcabfa9,
  paving: 0xd6cdb9,

  /** Architecture. */
  woodDark: 0x51392a,
  woodLight: 0xa57a51,
  plaster: 0xefe8da,
  roofTile: 0x4a4f52,
  roofThatch: 0x9c8358,
  vermilion: 0xc4503a,
  lighthouseWhite: 0xf4f0e6,

  /** Vegetation. */
  pine: 0x4d6b48,
  bamboo: 0x86a05a,
  maple: 0xb75c3c,

  /** Fog, matched to the horizon so the island dissolves rather than clips. */
  fog: 0xdfe6e4,
} as const;

/**
 * Typography. A system stack — the reference ships no webfont, and a 200 KB font would
 * be a third of our entire asset budget.
 */
export const TYPE = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif',
  /** Sizes in px at the 1× UI scale. The overlay scales these on small viewports. */
  size: { xs: 11, sm: 12.5, md: 14, lg: 17, xl: 22, display: 34 },
  weight: { regular: 400, medium: 500, bold: 600 },
  /** Letter-spacing for the small-caps labels used on badges and zone names. */
  trackLabel: '0.08em',
} as const;

/** Spacing scale, px. Four-based, so panels align without a grid system. */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 40 } as const;

/** Corner radii. Soft, but not pill-shaped — pills read as consumer app chrome. */
export const RADIUS = { sm: 4, md: 8, lg: 12, panel: 14 } as const;

/**
 * Motion. Everything in the interface moves on these three curves.
 *
 * `calm` is the default: slow enough to be noticed, never fast enough to demand
 * attention. Nothing in the UI is allowed to be faster than `quick`.
 */
export const MOTION = {
  quick: { duration: 180, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  calm: { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  slow: { duration: 900, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' },
} as const;

/** Layering. Kept small and named so no component invents its own z-index. */
export const LAYER = {
  scene: 0,
  worldLabels: 10,
  hud: 20,
  panel: 30,
  toast: 40,
  entry: 50,
  loader: 60,
} as const;

/**
 * Emit the token set as CSS custom properties.
 * Called once at boot so components can use `var(--ui-ink)` and stay declarative.
 */
export function tokensToCss(): string {
  const lines: string[] = [':root{'];
  for (const [k, v] of Object.entries(UI_COLORS)) {
    lines.push(`--ui-${kebab(k)}:${v};`);
  }
  for (const [k, v] of Object.entries(TYPE.size)) {
    lines.push(`--fs-${k}:${v}px;`);
  }
  for (const [k, v] of Object.entries(SPACE)) {
    lines.push(`--sp-${k}:${v}px;`);
  }
  for (const [k, v] of Object.entries(RADIUS)) {
    lines.push(`--r-${k}:${v}px;`);
  }
  for (const [k, v] of Object.entries(MOTION)) {
    lines.push(`--mo-${k}:${v.duration}ms ${v.easing};`);
  }
  for (const [k, v] of Object.entries(LAYER)) {
    lines.push(`--z-${kebab(k)}:${v};`);
  }
  lines.push(`--font-sans:${TYPE.sans};`);
  lines.push('}');
  return lines.join('');
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
