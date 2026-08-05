/**
 * The ink material.
 * =================
 *
 * Every solid surface in the world is drawn with this one shader. It is the whole art
 * direction in a single file: flat fills, a named shadow tone, pen hatching in the shade,
 * paper grain over the top, and — the part that makes the outlines possible — a second
 * render target carrying the surface information the contour pass needs.
 *
 * ### Why a custom material and not `MeshToonMaterial`
 *
 * Three's toon material gives a cel ramp and nothing else. It cannot write a second
 * buffer, so there is nowhere to put the view normal, the linear depth and the per-object
 * outline mask that a screen-space contour detector reads. Without those the only
 * available outline technique is the inverted hull (a second, back-facing, fattened copy
 * of every mesh), which doubles the scene's triangle count, cannot draw the *interior*
 * lines that make a drawing read as a drawing, and produces the pinched, uneven contours
 * that give inverted-hull games away.
 *
 * ### What it writes
 *
 * | target | channels | contents                                             |
 * |--------|----------|------------------------------------------------------|
 * | 0      | rgb      | shaded colour                                        |
 * | 0      | a        | material id, quantised — drives *interior* contours   |
 * | 1      | r        | linear view depth, inverted (see `DEPTH_CODEC`)      |
 * | 1      | gb       | view normal, spheremap-encoded                       |
 * | 1      | a        | outline participation mask (0 = never outlined)      |
 *
 * The material id is what lets a roof be outlined against the wall beneath it even though
 * the two are coplanar in depth and share a normal. Give two adjacent parts of a building
 * different ids and a line appears between them; give them the same id and they read as
 * one mass. That single number is most of what separates "a drawing" from "a 3D model
 * with edges detected on it".
 *
 * ### Lighting
 *
 * One key light, one sky fill, one bounce from the sea, and a shadow map. The terminator
 * is deliberately hard — the fill and bounce are what keep the shadow side readable, not
 * a soft falloff. Shadow *colour* is authored per material rather than derived by
 * multiplying the base colour down; see `SCENE_COLORS` for why.
 */

import * as THREE from 'three';
import { SCENE_COLORS } from '@nagisa/shared';
import { DEPTH_CODEC, NORMAL_CODEC, PAPER_NOISE } from './glsl.js';

/** Options accepted when building an ink material. */
export interface InkMaterialOptions {
  /** Base fill. Ignored when `vertexColors` is set — the mesh supplies it per vertex. */
  color?: THREE.ColorRepresentation;
  /**
   * Shadow tone. Defaults to a hue-shifted, desaturated derivative of `color` (see
   * {@link deriveShadow}) rather than a straight multiply, which is what keeps shadows
   * looking painted.
   */
  shadowColor?: THREE.ColorRepresentation;
  /**
   * Interior-contour group, 0–15. Adjacent surfaces with *different* ids get a drawn line
   * between them; surfaces sharing an id read as one continuous form.
   */
  matId?: number;
  /** Whether this surface participates in the contour pass at all. */
  outline?: boolean;
  /** Strength of the pen hatching on the shadow side, 0–1. */
  hatch?: number;
  /** Per-vertex colours (the terrain uses this; nothing else should need it). */
  vertexColors?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  /** Set on paper screens: an emissive lift driven by the day cycle. */
  glowColor?: THREE.ColorRepresentation;
  /** Skip lighting entirely and emit `color` flat. Lamps, glass, the lighthouse lens. */
  unlit?: boolean;
  flatShading?: boolean;
  depthWrite?: boolean;
}

/**
 * Derive a painted shadow tone from a base colour.
 *
 * Not `color * 0.5`. Real shade in a painting is cooler and less saturated than the light
 * it sits beside, and it converges toward the ambient rather than toward black — a wall in
 * shadow under a blue sky is a *blue-grey* wall, not a dark wall. So: rotate the hue
 * toward the cool end, cut saturation, drop lightness, then pull a little of the sky fill
 * in on top.
 */
export function deriveShadow(base: THREE.Color): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  // Push warm hues (reds/yellows, h < 0.5) up toward blue and leave already-cool hues
  // roughly alone, so a vermilion torii shades to a dusty plum and a green hillside to a
  // blue-green rather than both going grey.
  const shift = hsl.h < 0.5 ? 0.045 : 0.015;
  const out = new THREE.Color().setHSL((hsl.h + shift) % 1, hsl.s * 0.62, Math.max(0.08, hsl.l * 0.52));
  return out.lerp(new THREE.Color(SCENE_COLORS.skyFill), 0.14);
}

// ---------------------------------------------------------------------------
// Shared lighting uniforms
// ---------------------------------------------------------------------------

/**
 * Lighting state shared by every ink material in the scene.
 *
 * A single object whose `.value`s the sky director mutates once per frame. Every material
 * references *these* uniform objects, so one write updates the entire island — as opposed
 * to walking hundreds of materials, or paying for three.js's per-light uniform machinery
 * that we would then ignore.
 */
export const inkLighting = {
  /** Key-light direction in **world** space, pointing from the surface toward the sun. */
  uSunDir: { value: new THREE.Vector3(0.4, 0.82, 0.42).normalize() },
  uSunColor: { value: new THREE.Color(SCENE_COLORS.sunLight) },
  /** Fill from the sky dome, applied by how much a surface faces up. */
  uSkyColor: { value: new THREE.Color(SCENE_COLORS.skyFill) },
  /** Fill from the sea, applied by how much a surface faces down. */
  uBounceColor: { value: new THREE.Color(SCENE_COLORS.bounceLight) },
  /** Overall key strength; drops at dusk. */
  uSunStrength: { value: 1 },
  /** Ambient strength; rises slightly at dusk so nothing goes black. */
  uAmbient: { value: 0.34 },
  /** 0 at midday, 1 after dusk. Drives shoji glow and hatch density. */
  uNight: { value: 0 },
  /** Fog colour and density, matched to the sky. */
  uFogColor: { value: new THREE.Color(SCENE_COLORS.fog) },
  uFogDensity: { value: 0.00042 },
  /** Camera planes, shared with the ocean shader for its own fog match. */
  uCameraNear: { value: 0.5 },
  uCameraFar: { value: 3000 },
  /**
   * Reference range for the info buffer's depth encoding, metres. Not the camera's far
   * plane — see DEPTH_CODEC for why that distinction is what keeps the mountain from
   * rendering as a contour map.
   */
  uDepthScale: { value: 500 },
  /** Wall-clock seconds, for the very slight boil on the hatching. */
  uTime: { value: 0 },
};

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERTEX = /* glsl */ `
precision highp float;

#include <common>
#include <shadowmap_pars_vertex>

#ifdef USE_VCOLOR
  in vec3 color;
  out vec3 vVertexColor;
#endif

out vec3 vViewNormal;
out vec3 vWorldNormal;
out vec3 vViewPosition;

void main() {
  #ifdef USE_VCOLOR
    vVertexColor = color;
  #endif

  vec3 objectNormal = normal;
  vec3 transformedNormal = normalMatrix * objectNormal;
  vViewNormal = normalize(transformedNormal);
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = mvPosition.xyz;

  // three's shadow chunk expects these locals to exist under these exact names.
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vec3 transformed = position;
  #include <shadowmap_vertex>

  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

// The shadow chunks below have a strict include order and a hidden dependency chain:
// <shadowmask_pars_fragment> calls getShadow() from <shadowmap_pars_fragment>, and both
// read \`receiveShadow\` and the DirectionalLightShadow struct, which are declared in
// <lights_pars_begin>. That last include is also why the material sets \`lights: true\` —
// nothing here reads a light uniform directly, but three only wires the shadow map and
// shadow matrices into a ShaderMaterial's uniforms when that flag is on.
#include <common>
#include <packing>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

${NORMAL_CODEC}
${DEPTH_CODEC}
${PAPER_NOISE}

uniform vec3 uColor;
uniform vec3 uShadowColor;
uniform vec3 uGlowColor;
uniform float uGlowStrength;
uniform float uMatId;
uniform float uOutline;
uniform float uHatch;
uniform float uOpacity;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uBounceColor;
uniform float uSunStrength;
uniform float uAmbient;
uniform float uNight;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uDepthScale;
uniform float uTime;

#ifdef USE_VCOLOR
  in vec3 vVertexColor;
#endif
in vec3 vViewNormal;
in vec3 vWorldNormal;
in vec3 vViewPosition;

layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gInfo;

void main() {
  vec3 base = uColor;
  vec3 shade = uShadowColor;
  #ifdef USE_VCOLOR
    // Vertex colours arrive as authored sRGB values. Every other colour in this shader has
    // already been converted to linear working space by THREE.Color on upload, so these
    // have to be converted here or the terrain renders a stop and a half too bright —
    // which looks exactly like "the ambient is too strong" and sends you tuning the wrong
    // number for an hour.
    base *= pow(vVertexColor, vec3(2.2));
    // The terrain carries its fill per vertex, so its shadow tone has to be derived rather
    // than authored. Same recipe as deriveShadow(): cool it, desaturate it, and let it
    // fall toward the sky fill rather than toward black.
    shade = mix(base * 0.48, uSkyColor * 0.5, 0.24);
  #endif

  vec3 N = normalize(vWorldNormal);
  #ifdef FLIP_BACKFACE
    if (!gl_FrontFacing) N = -N;
  #endif

  #ifdef UNLIT
    vec3 lit = base;
  #else
    float ndl = dot(N, uSunDir);

    // Hard terminator. The band is a couple of degrees wide, not a gradient: what keeps
    // the dark side readable is the sky fill below, not a soft falloff here.
    float key = smoothstep(-0.02, 0.07, ndl);
    float shadowMask = getShadowMask();
    key *= shadowMask;
    key *= uSunStrength;

    vec3 lit = mix(shade, base, key);

    // A second, brighter band where the surface faces the sun most directly. Three tones
    // total: this is what gives a roof its sheen without introducing a gradient.
    float hi = smoothstep(0.52, 0.78, ndl) * shadowMask;
    lit = mix(lit, base * 1.09 + uSunColor * 0.05, hi * 0.55);

    // Sky above, sea below. Kept low: in a drawn world the shadow *colour* carries the
    // shade, and a generous ambient lift flattens every fill toward the same pale value.
    float up = N.y * 0.5 + 0.5;
    lit += uSkyColor * uAmbient * 0.22 * up;
    lit += uBounceColor * uAmbient * 0.14 * (1.0 - up);

    // Rim: a thin lift where the surface turns away from the eye, which reads as the
    // light wrapping round a form the way a painter draws it.
    vec3 V = normalize(-vViewPosition);
    float rim = pow(1.0 - clamp(dot(normalize(vViewNormal), V), 0.0, 1.0), 3.5);
    lit = mix(lit, lit + uSkyColor * 0.3, rim * 0.1);

    // Pen hatching on the shadow side. Two sets at different densities and phases, so it
    // reads as a hand building up tone rather than as a screen-door pattern.
    float shadeAmount = 1.0 - key;
    if (uHatch > 0.001 && shadeAmount > 0.01) {
      float boil = floor(uTime * 8.0) * 3.7; // stepped, so the strokes jitter rather than drift
      float h1 = penHatch(gl_FragCoord.xy, 0.055, boil);
      float h2 = penHatch(gl_FragCoord.xy, 0.098, boil + 40.0);
      float hatch = clamp(h1 * 0.72 + h2 * 0.45, 0.0, 1.0);
      lit = mix(lit, lit * 0.87, hatch * shadeAmount * uHatch);
    }

    lit += uGlowColor * uGlowStrength;
  #endif

  // Paper tooth over everything, including unlit surfaces — it is the medium, not a
  // property of the material.
  lit *= 1.0 + paperGrain(gl_FragCoord.xy) * 0.055;

  // Exponential-squared fog, matched to the sky so the far shore dissolves.
  float dist = length(vViewPosition);
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  lit = mix(lit, uFogColor, clamp(fogFactor, 0.0, 1.0));

  // Material id is quantised into 16 buckets. The contour pass compares neighbouring
  // pixels' ids, so what matters is that two different ids differ by a detectable step,
  // not that the value means anything on its own.
  gColor = vec4(lit, uMatId);

  vec3 viewN = normalize(vViewNormal);
  #ifdef FLIP_BACKFACE
    if (!gl_FrontFacing) viewN = -viewN;
  #endif
  gInfo = vec4(encodeLinearDepth(vViewPosition.z, uDepthScale), encodeNormalSpheremap(viewN), uOutline);

  #ifdef IS_TRANSPARENT
    gColor.a = uOpacity;
    if (uOpacity < 0.01) discard;
  #endif
}
`;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build an ink material.
 *
 * Callers should go through `world/materials.ts`, which caches by key — a scene built
 * from hundreds of small meshes needs them to *share* material instances or the renderer
 * cannot batch anything.
 */
export function createInkMaterial(options: InkMaterialOptions = {}): THREE.ShaderMaterial {
  const {
    color = 0xffffff,
    matId = 0,
    outline = true,
    hatch = 0.55,
    vertexColors = false,
    side = THREE.FrontSide,
    transparent = false,
    opacity = 1,
    glowColor = 0x000000,
    unlit = false,
    flatShading = true,
    depthWrite = true,
  } = options;

  const base = new THREE.Color(color);
  const shadow = options.shadowColor !== undefined ? new THREE.Color(options.shadowColor) : deriveShadow(base);

  const defines: Record<string, string | number | boolean> = {};
  if (vertexColors) defines.USE_VCOLOR = '';
  if (unlit) defines.UNLIT = '';
  if (transparent) defines.IS_TRANSPARENT = '';
  // Double-sided geometry (cloth, banners, water plants) needs its normal flipped on back
  // faces or half of every such surface is lit as though it faced the other way.
  if (side === THREE.DoubleSide) defines.FLIP_BACKFACE = '';

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines,
    // See the include block at the top of FRAGMENT: `lights: true` is what makes three
    // populate `directionalShadowMap` / `directionalShadowMatrix` on this material every
    // frame. `UniformsLib.lights` must be merged in alongside it — it carries the shadow
    // map, shadow matrix and per-light shadow slots as well as the light arrays, and
    // three writes into all of them unconditionally and throws if any are absent.
    lights: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      {
        uColor: { value: base },
        uShadowColor: { value: shadow },
        uGlowColor: { value: new THREE.Color(glowColor) },
        uGlowStrength: { value: 0 },
        // Spread ids across the 0–1 range in 16 steps; see the header for what this does.
        uMatId: { value: (matId % 16) / 15 },
        uOutline: { value: outline ? 1 : 0 },
        uHatch: { value: hatch },
        uOpacity: { value: opacity },
      },
    ]),
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side,
    transparent,
    depthWrite,
  });

  // Point the lighting uniforms at the *shared* objects rather than copies, so the sky
  // director's once-per-frame write reaches every material on the island.
  Object.assign(material.uniforms, inkLighting);

  (material as unknown as { flatShading: boolean }).flatShading = flatShading;

  return material;
}

/**
 * Shadow-casting depth material.
 *
 * A custom shader material is invisible to three's shadow pass unless it is told what to
 * render into the shadow map. One shared `MeshDepthMaterial` assigned as every mesh's
 * `customDepthMaterial` is enough: the ink materials are all opaque and none of them
 * displace vertices, so the depth-only silhouette is just the geometry.
 */
let sharedDepthMaterial: THREE.MeshDepthMaterial | null = null;

export function inkDepthMaterial(): THREE.MeshDepthMaterial {
  sharedDepthMaterial ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  return sharedDepthMaterial;
}

/** Update the camera planes shared with the ocean shader. */
export function setInkCamera(near: number, far: number): void {
  inkLighting.uCameraNear.value = near;
  inkLighting.uCameraFar.value = far;
}
