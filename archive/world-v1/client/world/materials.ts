/**
 * Shared material library.
 * ========================
 *
 * Every surface on the island comes from this file. Two reasons, and both are
 * load-bearing:
 *
 * 1. **One look.** The reference product's coherence comes from a single lighting model
 *    applied everywhere — a cel/toon ramp with a warm key, a cool sky fill and a bounce
 *    from the sea. Materials created ad hoc in prop files always drift.
 *
 * 2. **Batching.** Props are built as hundreds of small meshes. If each one owns its own
 *    material instance, the renderer cannot batch and a modest island costs 900 draw
 *    calls. Everything here is cached by key and shared by reference, which keeps a full
 *    scene in the low hundreds.
 *
 * Materials are **immutable once handed out**. If a prop needs a variant, ask for it by
 * key (`wood('dark')`) rather than mutating what you were given — you would be mutating
 * every other prop on the island.
 */

import * as THREE from 'three';
import { SCENE_COLORS } from '@nagisa/shared';

// ---------------------------------------------------------------------------
// The toon ramp
// ---------------------------------------------------------------------------

/**
 * Three-step gradient map driving `MeshToonMaterial`.
 *
 * Three bands, not four: two would read as flat vector art, four starts to look like
 * smooth shading with artefacts. The steps are biased toward the light end so shadowed
 * faces stay readable rather than going to mud.
 */
let gradientMap: THREE.DataTexture | null = null;

function getGradientMap(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const steps = new Uint8Array([88, 178, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.needsUpdate = true;
  // Nearest filtering is what produces the hard band edges. Linear would smear them.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  gradientMap = tex;
  return tex;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, THREE.Material>();

/**
 * Turn on faceted shading for a toon material.
 *
 * `MeshToonMaterial` does not declare `flatShading` — unlike `MeshStandardMaterial`, it
 * is absent from both the class and its TypeScript definition. The renderer, however,
 * reads the flag generically (`WebGLPrograms` tests `material.flatShading === true`) and
 * the `normal_fragment_begin` chunk implements the `FLAT_SHADED` path for every lit
 * shader, toon included. So setting it works exactly as it does on a standard material;
 * only the type definition is missing.
 *
 * This helper is where that fact is written down, so the assertion appears once rather
 * than at every material in the file. If a future three.js release adds the property
 * properly, deleting this function and assigning directly is the whole migration.
 */
function setFlatShading(material: THREE.Material, flat: boolean): void {
  (material as THREE.Material & { flatShading: boolean }).flatShading = flat;
}

/** Fetch-or-create a cached material. `make` runs at most once per key. */
function cached<T extends THREE.Material>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  const mat = make();
  mat.name = key;
  cache.set(key, mat);
  return mat;
}

/**
 * Core surface material: toon-shaded, opaque, no map.
 *
 * `flatShading` is the default because the island's geometry is low-poly by design and
 * faceted surfaces are what make it read as crafted rather than under-tessellated.
 */
export function surface(
  key: string,
  color: number,
  opts: { flat?: boolean; side?: THREE.Side; transparent?: boolean; opacity?: number } = {},
): THREE.MeshToonMaterial {
  const { flat = true, side = THREE.FrontSide, transparent = false, opacity = 1 } = opts;
  return cached(`surface:${key}`, () => {
    const m = new THREE.MeshToonMaterial({
      color,
      gradientMap: getGradientMap(),
      side,
      transparent,
      opacity,
    });
    setFlatShading(m, flat);
    return m;
  });
}

// ---------------------------------------------------------------------------
// Named materials
// ---------------------------------------------------------------------------

export type WoodTone = 'dark' | 'light' | 'beam';
export type RoofTone = 'tile' | 'thatch' | 'copper';

/** Structural timber. `beam` is a mid tone for exposed framing. */
export function wood(tone: WoodTone = 'dark'): THREE.MeshToonMaterial {
  const colors: Record<WoodTone, number> = {
    dark: SCENE_COLORS.woodDark,
    light: SCENE_COLORS.woodLight,
    beam: 0x6b4a34,
  };
  return surface(`wood-${tone}`, colors[tone]);
}

/** Roofing. Tile is the default for anything with a formal roof. */
export function roof(tone: RoofTone = 'tile'): THREE.MeshToonMaterial {
  const colors: Record<RoofTone, number> = {
    tile: SCENE_COLORS.roofTile,
    thatch: SCENE_COLORS.roofThatch,
    copper: 0x6f8f7a,
  };
  return surface(`roof-${tone}`, colors[tone]);
}

/** Wall plaster / shoji paper. Shoji is the same tone but slightly emissive at night. */
export function plaster(): THREE.MeshToonMaterial {
  return surface('plaster', SCENE_COLORS.plaster);
}

/**
 * Paper screens. Kept separate from plaster because they receive a warm emissive when
 * the day cycle passes dusk — lit windows are most of what makes a village feel occupied.
 */
export function shoji(): THREE.MeshToonMaterial {
  return cached('shoji', () => {
    const m = new THREE.MeshToonMaterial({
      color: 0xf6eeda,
      gradientMap: getGradientMap(),
      emissive: new THREE.Color(0xffd9a0),
      emissiveIntensity: 0,
    });
    setFlatShading(m, true);
    return m;
  });
}

/** The single accent. Torii, shrine trim, the lighthouse band. Use sparingly. */
export function vermilion(): THREE.MeshToonMaterial {
  return surface('vermilion', SCENE_COLORS.vermilion);
}

/** Weathered stone: lanterns, steps, sea walls. */
export function stone(variant: 'light' | 'dark' = 'light'): THREE.MeshToonMaterial {
  return surface(`stone-${variant}`, variant === 'light' ? 0xb8b2a6 : SCENE_COLORS.rock);
}

/** Whitewash for the lighthouse tower. */
export function whitewash(): THREE.MeshToonMaterial {
  return surface('whitewash', SCENE_COLORS.lighthouseWhite);
}

/** Foliage. Alpha-free — leaves are geometry, not cutout planes, at this scale. */
export function foliage(kind: 'pine' | 'bamboo' | 'maple' | 'shrub' = 'pine'): THREE.MeshToonMaterial {
  const colors = {
    pine: SCENE_COLORS.pine,
    bamboo: SCENE_COLORS.bamboo,
    maple: SCENE_COLORS.maple,
    shrub: 0x6f8f55,
  } as const;
  return surface(`foliage-${kind}`, colors[kind]);
}

/** Rope, cloth banners, noren curtains. Double-sided by necessity. */
export function cloth(color = 0xe8ded0): THREE.MeshToonMaterial {
  return surface(`cloth-${color.toString(16)}`, color, { side: THREE.DoubleSide });
}

/**
 * Emissive material for lantern glow and the lighthouse lamp. Not toon-shaded: a light
 * source that responds to lighting looks wrong.
 */
export function glow(color = 0xffce8a, intensity = 1): THREE.MeshBasicMaterial {
  return cached(`glow-${color.toString(16)}-${intensity}`, () => {
    const c = new THREE.Color(color).multiplyScalar(intensity);
    return new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  });
}

/** Ground surfaces used by both the terrain mesh and paved props. */
export function ground(kind: 'sand' | 'grass' | 'rock' | 'path' | 'paving'): THREE.MeshToonMaterial {
  const colors = {
    sand: SCENE_COLORS.sand,
    grass: SCENE_COLORS.grass,
    rock: SCENE_COLORS.rock,
    path: SCENE_COLORS.path,
    paving: SCENE_COLORS.paving,
  } as const;
  return surface(`ground-${kind}`, colors[kind]);
}

/**
 * Vertex-coloured terrain material.
 *
 * The island's ground is one mesh whose colours are baked into vertex attributes by the
 * terrain builder (sand near the waterline, grass inland, rock on steep faces). One
 * material, one draw call, no texture download.
 */
export function terrainMaterial(): THREE.MeshToonMaterial {
  return cached('terrain', () => {
    const m = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: getGradientMap(),
    });
    setFlatShading(m, true);
    return m;
  });
}

// ---------------------------------------------------------------------------
// Night response
// ---------------------------------------------------------------------------

/**
 * Drive the emissive response of paper screens and lanterns from the day cycle.
 * `night` is 0 at midday and 1 after dusk. Called once per frame by the scene director,
 * never per prop.
 */
export function setNightFactor(night: number): void {
  const s = cache.get('shoji') as THREE.MeshToonMaterial | undefined;
  if (s) s.emissiveIntensity = night * 0.85;
}

/** Release every cached material. Called only on full teardown (hot reload, room swap). */
export function disposeMaterials(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  gradientMap?.dispose();
  gradientMap = null;
}
