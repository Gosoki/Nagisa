/**
 * Shared material library.
 * ========================
 *
 * Every surface on the island comes from this file. Two reasons, and both are
 * load-bearing:
 *
 * 1. **One look.** The world's coherence comes from a single shading model applied
 *    everywhere — see `engine/ink/ink-material.ts`. Materials created ad hoc in prop files
 *    always drift, and in a drawn style drift is instantly visible.
 *
 * 2. **Batching.** Props are built as hundreds of small meshes. If each one owns its own
 *    material instance the renderer cannot batch and a modest island costs 900 draw calls.
 *    Everything here is cached by key and shared by reference, which keeps a full scene in
 *    the low hundreds.
 *
 * Materials are **immutable once handed out**. If a prop needs a variant, ask for it by
 * key (`wood('light')`) rather than mutating what you were given — you would be mutating
 * every other prop on the island.
 *
 * ### Material ids and the contour pass
 *
 * Each entry carries a `matId`. Two adjacent surfaces with different ids get a drawn line
 * between them even when their geometry is flush; surfaces sharing an id read as one
 * continuous mass. The ids below are grouped by *what a person drawing this would treat
 * as one object*: all the timber of a building shares an id, its roof has another, its
 * plaster a third. Getting these wrong is the difference between a building that reads as
 * built and one that reads as extruded.
 */

import * as THREE from 'three';
import { SCENE_COLORS } from '@nagisa/shared';
import { createInkMaterial, type InkMaterialOptions } from '../engine/ink/ink-material.js';

/**
 * Contour groups. Values are arbitrary but must be distinct where a line is wanted and
 * shared where it is not; 16 slots is what the material-id channel quantises to.
 */
export const MAT_ID = {
  ground: 0,
  stone: 1,
  timber: 2,
  plaster: 3,
  roof: 4,
  paper: 5,
  metal: 6,
  cloth: 7,
  accent: 8,
  water: 9,
  skin: 10,
  hair: 11,
  clothingA: 12,
  clothingB: 13,
  glow: 14,
  rock: 15,
} as const;

const cache = new Map<string, THREE.ShaderMaterial>();

/** Fetch-or-create a cached material. `make` runs at most once per key. */
function cached(key: string, make: () => THREE.ShaderMaterial): THREE.ShaderMaterial {
  const hit = cache.get(key);
  if (hit) return hit;
  const material = make();
  material.name = key;
  cache.set(key, material);
  return material;
}

/**
 * Core surface material. Everything else in this file is a named call to this.
 *
 * @param key  Cache key. Two calls with the same key return the *same instance*.
 */
export function surface(key: string, options: InkMaterialOptions): THREE.ShaderMaterial {
  return cached(`surface:${key}`, () => createInkMaterial(options));
}

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

export type WoodTone = 'dark' | 'light' | 'beam' | 'weathered';

/** Structural timber. `beam` is a mid tone for exposed framing. */
export function wood(tone: WoodTone = 'dark'): THREE.ShaderMaterial {
  const tones: Record<WoodTone, [number, number]> = {
    dark: [SCENE_COLORS.woodDark, SCENE_COLORS.woodDarkShadow],
    light: [SCENE_COLORS.woodLight, SCENE_COLORS.woodLightShadow],
    beam: [0x967a5c, 0x6f6153],
    weathered: [0xaea69a, 0x87837b],
  };
  const [color, shadowColor] = tones[tone];
  return surface(`wood-${tone}`, { color, shadowColor, matId: MAT_ID.timber, hatch: 0.6 });
}

export type RoofTone = 'tile' | 'thatch' | 'copper' | 'terracotta' | 'board';

/** Roofing. Tile is the default for anything with a formal roof. */
export function roof(tone: RoofTone = 'tile'): THREE.ShaderMaterial {
  const tones: Record<RoofTone, [number, number]> = {
    tile: [SCENE_COLORS.roofTile, SCENE_COLORS.roofTileShadow],
    thatch: [SCENE_COLORS.roofThatch, SCENE_COLORS.roofThatchShadow],
    copper: [SCENE_COLORS.roofCopper, SCENE_COLORS.roofCopperShadow],
    terracotta: [SCENE_COLORS.terracotta, SCENE_COLORS.terracottaShadow],
    board: [0x9d8d76, 0x776f60],
  };
  const [color, shadowColor] = tones[tone];
  // Roofs carry the strongest hatching on the island: they are the largest shadow-side
  // planes you see from ground level, and they are where the drawn quality has to land.
  return surface(`roof-${tone}`, { color, shadowColor, matId: MAT_ID.roof, hatch: 0.8 });
}

/** Wall plaster. */
export function plaster(): THREE.ShaderMaterial {
  return surface('plaster', {
    color: SCENE_COLORS.plaster,
    shadowColor: SCENE_COLORS.plasterShadow,
    matId: MAT_ID.plaster,
    hatch: 0.45,
  });
}

/**
 * Paper screens. Kept separate from plaster because they take a warm emissive lift once
 * the day cycle passes dusk — lit windows are most of what makes a village feel occupied.
 */
export function shoji(): THREE.ShaderMaterial {
  return surface('shoji', {
    color: SCENE_COLORS.shoji,
    shadowColor: 0xd6cdba,
    glowColor: SCENE_COLORS.shojiGlow,
    matId: MAT_ID.paper,
    hatch: 0.2,
  });
}

/** The single accent. Torii, shrine trim, the lighthouse band. Use sparingly. */
export function vermilion(): THREE.ShaderMaterial {
  return surface('vermilion', {
    color: SCENE_COLORS.vermilion,
    shadowColor: SCENE_COLORS.vermilionShadow,
    matId: MAT_ID.accent,
    hatch: 0.5,
  });
}

/** Weathered stone: lanterns, steps, sea walls, komainu. */
export function stone(variant: 'light' | 'dark' = 'light'): THREE.ShaderMaterial {
  const [color, shadowColor] =
    variant === 'light'
      ? [SCENE_COLORS.stone, SCENE_COLORS.stoneShadow]
      : [SCENE_COLORS.cliff, SCENE_COLORS.cliffShadow];
  return surface(`stone-${variant}`, { color, shadowColor, matId: MAT_ID.stone, hatch: 0.55 });
}

/** Whitewash for the lighthouse tower. */
export function whitewash(): THREE.ShaderMaterial {
  return surface('whitewash', {
    color: SCENE_COLORS.lighthouseWhite,
    shadowColor: SCENE_COLORS.lighthouseWhiteShadow,
    matId: MAT_ID.plaster,
    hatch: 0.5,
  });
}

/** Dark metal: hardware, bells, railings, lamp housings. */
export function metal(variant: 'dark' | 'bronze' = 'dark'): THREE.ShaderMaterial {
  const [color, shadowColor] = variant === 'dark' ? [0x5f666a, 0x454c50] : [0xa89066, 0x7d6d52];
  return surface(`metal-${variant}`, { color, shadowColor, matId: MAT_ID.metal, hatch: 0.4 });
}

/** Rope, cloth banners, noren curtains. Double-sided by necessity. */
export function cloth(color = 0xe8ded0): THREE.ShaderMaterial {
  return surface(`cloth-${color.toString(16)}`, {
    color,
    matId: MAT_ID.cloth,
    side: THREE.DoubleSide,
    hatch: 0.35,
  });
}

/**
 * Unlit emissive for lantern flames and the lighthouse lamp. Not shaded — a light source
 * that responds to lighting looks wrong — and excluded from the contour pass, because a
 * pen line around a glow reads as a sticker.
 */
export function glow(color = 0xffce8a): THREE.ShaderMaterial {
  return surface(`glow-${color.toString(16)}`, {
    color,
    matId: MAT_ID.glow,
    unlit: true,
    outline: false,
    hatch: 0,
  });
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/** Ground surfaces used by paved props (the terrain itself is vertex-coloured). */
export function ground(kind: 'sand' | 'grass' | 'rock' | 'path' | 'paving'): THREE.ShaderMaterial {
  const tones = {
    sand: [SCENE_COLORS.sand, SCENE_COLORS.sandShadow],
    grass: [SCENE_COLORS.grass, SCENE_COLORS.grassShadow],
    rock: [SCENE_COLORS.rock, SCENE_COLORS.rockShadow],
    path: [SCENE_COLORS.path, SCENE_COLORS.pathShadow],
    paving: [SCENE_COLORS.paving, SCENE_COLORS.pavingShadow],
  } as const;
  const [color, shadowColor] = tones[kind];
  return surface(`ground-${kind}`, { color, shadowColor, matId: MAT_ID.ground, hatch: 0.3 });
}

/** Shoreline boulders and mountain outcrops. */
export function rockFace(): THREE.ShaderMaterial {
  return surface('rock-face', {
    color: SCENE_COLORS.rock,
    shadowColor: SCENE_COLORS.rockShadow,
    matId: MAT_ID.rock,
    hatch: 0.65,
  });
}

/**
 * Vertex-coloured terrain material.
 *
 * The island's ground is one mesh whose colours are baked into vertex attributes by the
 * terrain builder (sand near the waterline, grass inland, rock on steep faces, paving on
 * the roads). One material, one draw call, no texture download.
 *
 * ### Two settings here are not stylistic preferences
 *
 * `flatShading: false` is **required**, not a look. The terrain is a 400 × 400 grid, and
 * flat shading gives every one of its 320 000 triangles its own normal — which the
 * contour pass then dutifully detects, drawing a pen line along every triangle edge and
 * turning the mountain into a topographic map. The worker already computes exact analytic
 * normals per vertex, so smooth shading here is both correct and free.
 *
 * Hatching is turned down relative to architecture for the same reason in a softer form:
 * hatching an entire hillside makes the ground compete with the buildings on it.
 */
export function terrainMaterial(): THREE.ShaderMaterial {
  return surface('terrain', {
    vertexColors: true,
    // `surfaceBands` overrides `matId` per fragment from the mesh's `aSurfaceBand`
    // attribute. The terrain is one mesh carrying every ground on the island, and with a
    // single id the contour pass had nothing to find on it — a paved square drew as blank
    // paper. `matId` stays as the fallback for any build that does not supply the attribute.
    surfaceBands: true,
    matId: MAT_ID.ground,
    hatch: 0.22,
    flatShading: false,
  });
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

/** Skin. Index selects from the entry screen's palette. */
export function skin(index: number): THREE.ShaderMaterial {
  const tones: [number, number][] = [
    [0xf2d9c0, 0xd2b8a4],
    [0xe3bb98, 0xc09a84],
    [0xc4956c, 0xa07660],
    [0x94684b, 0x74503f],
    [0x6b4a35, 0x53392f],
  ];
  const [color, shadowColor] = tones[index % tones.length];
  return surface(`skin-${index}`, { color, shadowColor, matId: MAT_ID.skin, hatch: 0.25 });
}

/** Hair. */
export function hair(index: number): THREE.ShaderMaterial {
  const tones: [number, number][] = [
    [0x453a2d, 0x332c25],
    [0x6b4a30, 0x4f3a2b],
    [0x9a7748, 0x745c3c],
    [0xc9a86b, 0x9c8659],
    [0x9a6659, 0x745048],
    [0x5a6070, 0x434857],
  ];
  const [color, shadowColor] = tones[index % tones.length];
  return surface(`hair-${index}`, { color, shadowColor, matId: MAT_ID.hair, hatch: 0.4 });
}

/**
 * Outfit colours. `layer` distinguishes the two garment ids so a jacket is outlined
 * against the trousers underneath it.
 */
export function outfit(index: number, layer: 'a' | 'b'): THREE.ShaderMaterial {
  const tones: [number, number][] = [
    [0x5f8090, 0x466373], // indigo work jacket
    [0xc4503a, 0x9c4536], // vermilion
    [0xeee8db, 0xcbc6ba], // undyed cotton
    [0x81926a, 0x63744f], // moss
    [0xa87b5e, 0x836049], // clay
    [0x515769, 0x3c414f], // charcoal
    [0xd8a25e, 0xae8154], // ochre
    [0x9a80ab, 0x776289], // plum
  ];
  const [color, shadowColor] = tones[index % tones.length];
  return surface(`outfit-${index}-${layer}`, {
    color,
    shadowColor,
    matId: layer === 'a' ? MAT_ID.clothingA : MAT_ID.clothingB,
    hatch: 0.5,
  });
}

// ---------------------------------------------------------------------------
// Day cycle
// ---------------------------------------------------------------------------

/**
 * Drive the emissive response of paper screens and lanterns from the day cycle.
 * `night` is 0 at midday and 1 after dusk. Called once per frame by the scene director,
 * never per prop.
 */
export function setNightFactor(night: number): void {
  const screens = cache.get('surface:shoji');
  if (screens) screens.uniforms.uGlowStrength.value = night * 0.55;
}

/** Release every cached material. Called only on full teardown (hot reload, room swap). */
export function disposeMaterials(): void {
  for (const material of cache.values()) material.dispose();
  cache.clear();
}
