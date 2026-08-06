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

/**
 * Scene palette. Hex numbers, ready for `new THREE.Color()`.
 *
 * ### Why these particular colours
 *
 * The world is drawn, not lit. Everything is rendered as a flat fill plus a *named*
 * shadow tone and an ink contour, so the palette has to carry the whole atmosphere on its
 * own — there is no physically-based falloff doing the work.
 *
 * Three rules, taken from the reference product:
 *
 * 1. **Nothing is saturated except the accent.** Greens go through olive rather than
 *    emerald, greys are warm, the sea is desaturated teal. A single vermilion is the only
 *    pure hue on the island, and it appears on torii and almost nothing else.
 * 2. **Shadows are hue-shifted, not darkened.** `*Shadow` entries are cooler and slightly
 *    violet, never the base colour multiplied down. This is the single biggest difference
 *    between "cel-shaded 3D" and "a painting". They are authored in pairs, right next to
 *    each other, so drift is visible in review.
 *
 *    They are also *shallow*: a shadow tone sits around 70–80% of its base's luminance,
 *    not 50%. The world is high-key — light masses with dark line work — and the contour
 *    pass is what draws the form. Deep shadow tones fight it: every wall facing away from
 *    the sun turns into a black slab, the pen lines vanish inside it, and the result reads
 *    as an unlit 3D model rather than as a drawing. If a surface looks flat, the fix is a
 *    material id (a line), never a darker shadow.
 * 3. **Ink is a warm near-black slate, never #000.** Pure black contours read as vector
 *    art; `#373f42` reads as a pen.
 */
export const SCENE_COLORS = {
  /** Sky gradient, horizon → zenith. Pale and high-key so the island reads dark against it. */
  skyHorizon: 0xeef0e6,
  skyZenith: 0x9dc5cb,
  /** Flat card the sea and sky meet on when fog takes over. */
  skyHaze: 0xdfe8e4,

  /** Key light, its shadow tone, and the fill bouncing up off the water. */
  sunLight: 0xfff4e0,
  skyFill: 0xa9c6cd,
  bounceLight: 0x86aab0,

  /** The single ink colour every contour in the world is drawn with. */
  ink: 0x373f42,

  /** Water: flat teal, a deeper offshore tone, and the drawn foam line. */
  waterShallow: 0x74bdb2,
  waterMid: 0x4e9e9c,
  waterDeep: 0x336f7d,
  waterFoam: 0xf6faf5,

  /** Ground, each with its paired shadow tone. */
  sand: 0xe6dcc2,
  sandShadow: 0xcac4b2,
  grass: 0x88a06a,
  grassShadow: 0x6f8a72,
  grassDry: 0xa9ab7c,
  grassDryShadow: 0x8b9270,
  rock: 0xb0a794,
  rockShadow: 0x968f83,
  cliff: 0x8e887a,
  cliffShadow: 0x777a76,
  path: 0xb2a58a,
  pathShadow: 0xbdb8a5,
  paving: 0xd2c9b2,
  pavingShadow: 0xb4b0a0,

  /** Architecture. */
  woodDark: 0x7a6046,
  woodDarkShadow: 0x5b4c40,
  woodLight: 0xc0a179,
  woodLightShadow: 0x94806a,
  plaster: 0xf4efe4,
  plasterShadow: 0xd2d1c8,
  roofTile: 0x808f94,
  roofTileShadow: 0x63727a,
  roofThatch: 0xb39a70,
  roofThatchShadow: 0x8d7d60,
  roofCopper: 0x8dab9c,
  roofCopperShadow: 0x6c857c,
  terracotta: 0xc4663f,
  terracottaShadow: 0xa25b45,
  vermilion: 0xc4503a,
  vermilionShadow: 0x9e4a3b,
  lighthouseWhite: 0xf4f1e8,
  lighthouseWhiteShadow: 0xd6d6cf,
  stone: 0xc7c0b2,
  stoneShadow: 0xa5a298,

  /** Paper screens: the warm glow behind shoji after dusk. */
  shoji: 0xf7efdc,
  shojiGlow: 0xffd79c,

  /** Fog, matched to the horizon so the island dissolves rather than clips. */
  fog: 0xdfe8e4,
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
