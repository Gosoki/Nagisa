/**
 * The contour pass.
 * =================
 *
 * Renders the scene into two targets and then draws the pen lines by comparing
 * neighbouring pixels of the second one. This is the pass that makes Nagisa look drawn
 * rather than modelled.
 *
 * ### How the detector works
 *
 * For each pixel it samples a **five-tap cross** — centre, left, right, up, down — of the
 * info buffer and the colour buffer's alpha, and measures three kinds of discontinuity:
 *
 * - **Depth.** A jump in linear view depth is a silhouette: one surface in front of
 *   another. This draws the outside of every object.
 * - **Normal.** A change in surface orientation with no depth jump is a crease: the ridge
 *   of a roof, the corner of a wall, the fold of a sleeve. This draws the *inside* of
 *   objects, which is most of what makes a drawing legible.
 * - **Material id.** Two surfaces that are coplanar *and* parallel — a painted band on a
 *   lighthouse, a roof meeting the wall it sits flush against — have no geometric
 *   discontinuity at all. Comparing the authored id catches those. Without this third
 *   test, buildings lose exactly the lines a person would draw first.
 *
 * Each is measured as a *second difference* across the cross rather than a plain gradient,
 * which is what keeps a smoothly curving surface from being outlined along its whole
 * length: a sphere's normal changes continuously, so its first derivative is large
 * everywhere and its second is large only at the silhouette.
 *
 * ### Distance fade, and why it is not optional
 *
 * A one-pixel line is one pixel wide whether the thing it describes is two metres away or
 * two hundred. Left alone, a distant village turns into a solid mat of ink. The
 * contribution is therefore faded out with view depth, so far geometry keeps its
 * silhouette and loses its interior detail — which is also, conveniently, how a person
 * draws a distant village.
 *
 * ### Why the outline mask exists
 *
 * The sea and sky write 0 into the mask channel and are never outlined. Water outlined
 * against the shore reads as a hard cut-out; the shoreline wants a drawn foam line, which
 * the ocean shader draws itself, not a contour.
 *
 * The structure of this pass — an MRT geometry buffer packing depth, encoded normal and a
 * mask, plus a cross-shaped detector with separate id/normal/depth thresholds and a
 * distance fade — follows the approach used by the reference product, which is a
 * well-established stylised-rendering technique rather than anything proprietary. The
 * implementation here is our own.
 */

import * as THREE from 'three';
import { SCENE_COLORS } from '@nagisa/shared';
import { DEPTH_CODEC, FIT, NORMAL_CODEC, PAPER_NOISE } from './glsl.js';
import { inkLighting } from './ink-material.js';

/** Tunables, gathered so the whole look can be adjusted from one place. */
export interface InkPassSettings {
  /** Line width in pixels at the reference resolution. */
  thickness: number;
  /** Ink colour. Warm slate, never black. */
  color: THREE.ColorRepresentation;
  /** View distances (metres) over which interior lines fade out entirely. */
  fadeNear: number;
  fadeFar: number;
  /** Depth detector: (inMin, inMax, threshold), in *relative* depth units. */
  depthRange: THREE.Vector3;
  /**
   * Estimated per-sample depth quantisation, as a fraction of view distance. Subtracted
   * from the raw depth difference before thresholding — see the noise-floor note in the
   * composite shader for why this is the difference between a drawing and a black slab.
   */
  depthNoise: number;
  /** Normal detector: (inMin, inMax, threshold). */
  normalRange: THREE.Vector3;
  /** Material-id detector: (inMin, inMax, threshold). */
  idRange: THREE.Vector3;
  /** Soft margin applied above each threshold, so lines have an antialiased edge. */
  smoothMargin: number;
  /** Strength of the paper grain in the final composite, 0–1. */
  paper: number;
  /** Corner darkening, 0–1. */
  vignette: number;
}

export const DEFAULT_INK_SETTINGS: InkPassSettings = {
  thickness: 1.0,
  color: SCENE_COLORS.ink,
  fadeNear: 60,
  fadeFar: 340,
  // Relative units: see the composite shader.
  //
  // These are set by what has to be *rejected*, not by what has to be drawn. The terrain
  // is a 1.6 m grid, so at any distance its facet-to-facet depth steps land around 0.002
  // in relative units — well above the half-float noise floor and completely invisible to
  // the eye, but a detector tuned any tighter than this draws every one of them. The
  // result is a hillside ruled with horizontal lines at constant depth, which reads as a
  // rendering artefact and not as draughtsmanship.
  //
  // 0.0035 sits above that; a real silhouette (a metre of gap at a hundred metres, or half
  // a metre at ten) clears it comfortably. Interior detail the depth test gives up on this
  // way — tile courses, plank lines — is picked up by the normal and material-id tests,
  // which is what they are for.
  depthRange: new THREE.Vector3(0.0035, 0.018, 0.22),
  depthNoise: 0.0025,
  normalRange: new THREE.Vector3(0.4, 0.5, 0.3),
  idRange: new THREE.Vector3(0.0004, 0.002, 0.1),
  smoothMargin: 0.2,
  paper: 0.5,
  vignette: 0.22,
};

const COMPOSITE_VERT = /* glsl */ `
precision highp float;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tColor;
uniform sampler2D tInfo;
uniform vec2 uResolution;
uniform float uThickness;
uniform vec3 uInkColor;
uniform vec2 uFade;
uniform vec3 uDepthRange;
uniform float uDepthNoise;
uniform vec3 uNormalRange;
uniform vec3 uIdRange;
uniform float uSmoothMargin;
uniform float uPaper;
uniform float uVignette;
uniform float uDepthScale;
uniform float uWarmth;
uniform int uDebug;

in vec2 vUv;
out vec4 fragColor;

${NORMAL_CODEC}
${DEPTH_CODEC}
${PAPER_NOISE}
${FIT}

void main() {
  vec4 centre = texture(tColor, vUv);
  vec3 scene = centre.rgb;

  // Scale the sample offset with resolution so the line stays the same *apparent* weight
  // on a phone and on a 5K display — a fixed pixel offset gives a hairline on one and a
  // marker pen on the other.
  vec2 texel = 1.0 / uResolution;
  float resScale = clamp(uResolution.y / 1080.0, 0.55, 1.6);
  vec2 offset = texel * uThickness * resScale;

  const vec2 dirs[5] = vec2[5](vec2(0.0), vec2(-1.0, 0.0), vec2(1.0, 0.0), vec2(0.0, -1.0), vec2(0.0, 1.0));

  float depths[5];
  vec3 normals[5];
  float ids[5];
  float masks[5];

  for (int i = 0; i < 5; i++) {
    vec2 uv = vUv + offset * dirs[i];
    vec4 info = texture(tInfo, uv);
    depths[i] = decodeLinearDepth(info.r, uDepthScale);
    normals[i] = decodeNormalSpheremap(info.gb);
    masks[i] = info.a;
    ids[i] = texture(tColor, uv).a;
  }

  float centreDepth = depths[0];
  vec3 centreNormal = normals[0];
  float centreId = ids[0];
  float mask = masks[0];

  // Second differences across the cross, per axis. (a - c) - (b - c) collapses to a - b,
  // but writing it this way keeps the intent visible: it is the curvature of the field,
  // not its slope.
  vec2 depthVar = vec2(depths[1] - centreDepth - (depths[2] - centreDepth),
                       depths[3] - centreDepth - (depths[4] - centreDepth));
  vec2 normalVar = vec2(distance(normals[1], centreNormal) - distance(normals[2], centreNormal),
                        distance(normals[3], centreNormal) - distance(normals[4], centreNormal));
  vec2 idVar = vec2(ids[1] - centreId - (ids[2] - centreId),
                    ids[3] - centreId - (ids[4] - centreId));

  // --- Depth, in relative units, above a noise floor --------------------------------
  //
  // Two corrections turn a raw metre difference into something a single threshold can
  // judge at any distance.
  //
  // **Noise floor.** The info buffer is half-float, whose precision is relative: depth at
  // 30 m quantises to about 1.5 cm and at 300 m to about 15 cm. A fixed threshold in
  // metres is therefore below the quantisation almost everywhere, and the detector fires
  // on rounding error across every flat surface in the scene — which does not look like
  // noise, it looks like every building being *filled* with solid ink. Subtracting an
  // estimate of the quantisation first makes a genuinely flat surface score exactly zero.
  //
  // **Relative, not absolute.** After the floor, the difference is divided by view
  // distance, so "a step big enough to draw" means the same thing on a lantern beside you
  // and on a lighthouse across the bay.
  float quantisation = centreDepth * uDepthNoise;
  float depthTotal = max(0.0, length(depthVar) - quantisation) / max(1.0, centreDepth);
  float normalTotal = length(normalVar);
  float idTotal = length(idVar);

  // A surface seen edge-on is the standard false positive, and it fools *both* geometric
  // detectors for the same reason: one pixel spans metres of it. The ground running away
  // toward the horizon has a huge depth gradient without being a silhouette, and its
  // normal changes measurably between neighbouring pixels without there being a crease —
  // which shows up as horizontal streaks lying across the terrain. Raising both thresholds
  // as the surface turns away from the camera suppresses exactly that, and costs nothing
  // on the surfaces facing you, where all the lines that matter are.
  float grazing = 1.0 - abs(centreNormal.z);
  float depthLimit = uDepthRange.z + grazing * 1.2;
  float normalLimit = uNormalRange.z + grazing * grazing * 0.85;

  float depthContribution = fit(fit(depthTotal, uDepthRange.x, uDepthRange.y, 0.0, 1.0),
                                depthLimit, depthLimit + uSmoothMargin, 0.0, 1.0);
  float normalContribution = fit(fit(normalTotal, uNormalRange.x, uNormalRange.y, 0.0, 1.0),
                                 normalLimit, normalLimit + uSmoothMargin, 0.0, 1.0);
  float idContribution = fit(fit(idTotal, uIdRange.x, uIdRange.y, 0.0, 1.0),
                             uIdRange.z, uIdRange.z + uSmoothMargin, 0.0, 1.0);

  // The nearest of the five samples owns the line. Without this, a silhouette is drawn
  // half on the near object and half on the far one, and the line visibly straddles the
  // edge instead of sitting on it.
  float nearestDepth = centreDepth;
  float nearestMask = mask;
  for (int i = 1; i < 5; i++) {
    if (depths[i] < nearestDepth) {
      nearestDepth = depths[i];
      nearestMask = masks[i];
    }
  }
  if (nearestMask > mask) mask = ceil(nearestMask);

  float lineAmount = clamp(depthContribution + normalContribution + idContribution, 0.0, 1.0);
  lineAmount *= mask;
  lineAmount *= fit(nearestDepth, uFade.x, uFade.y, 1.0, 0.0);

  // Detector debug views. Which of the three tests is drawing a given line is impossible
  // to tell from the composited frame — they all produce the same ink — so each one gets
  // a channel of its own here. See InkPass.setDebug().
  if (uDebug > 0) {
    vec3 dbg = vec3(0.0);
    if (uDebug == 1) dbg = vec3(depthContribution, normalContribution, idContribution);
    else if (uDebug == 2) dbg = vec3(depthContribution);
    else if (uDebug == 3) dbg = vec3(normalContribution);
    else if (uDebug == 4) dbg = vec3(idContribution);
    else if (uDebug == 5) dbg = vec3(centreDepth / uDepthScale);
    else if (uDebug == 6) dbg = centreNormal * 0.5 + 0.5;
    fragColor = vec4(dbg, 1.0);
    return;
  }

  // The ink itself picks up a little of the paper grain, so a long contour is not a
  // perfectly even stroke.
  float grain = paperGrain(gl_FragCoord.xy * 0.8);
  vec3 ink = uInkColor * (1.0 + grain * 0.18);
  scene = mix(scene, ink, lineAmount);

  // --- Display space -----------------------------------------------------------------
  // Everything up to here is linear: the geometry buffer is half-float linear, and
  // THREE.Color converts authored sRGB hex into linear working space on upload. The grade
  // below is a *pictorial* adjustment — contrast pivoted on mid-grey, a warm/cool split —
  // and those only behave the way an eye expects in display space, so the conversion
  // happens first. This pass writes straight to the canvas, so it also has to do the
  // conversion three would otherwise apply for a built-in material.
  scene = clamp(scene, 0.0, 1.0);
  scene = mix(scene * 12.92, 1.055 * pow(scene, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, scene));

  // Standing in for the reference product's 3D LUT: a warm lift in the highlights, a cool
  // foot in the shadows, and a gentle contrast curve. Cheaper than a LUT texture, and it
  // is the shape of the grade that matters, not its exact table.
  float luma = dot(scene, vec3(0.2126, 0.7152, 0.0722));
  scene = mix(scene, scene * vec3(1.03, 1.0, 0.95), uWarmth * luma);
  scene = mix(scene, scene * vec3(0.94, 0.98, 1.06), uWarmth * (1.0 - luma) * 0.7);
  scene = clamp((scene - 0.5) * 1.045 + 0.5, 0.0, 1.0);

  // Paper over the whole frame, ink included.
  scene *= 1.0 + grain * 0.09 * uPaper;

  // A soft vignette, as though the drawing sits on a page rather than filling a screen.
  vec2 centred = vUv - 0.5;
  float vig = 1.0 - uVignette * dot(centred, centred) * 1.6;
  scene *= vig;

  fragColor = vec4(clamp(scene, 0.0, 1.0), 1.0);
}
`;

/**
 * The ink render pipeline.
 *
 * Owns the two-target geometry buffer and the fullscreen composite. Call {@link setSize}
 * on resize and {@link render} once per frame instead of `renderer.render(...)`.
 */
export class InkPass {
  private target: THREE.WebGLRenderTarget;
  private readonly composite: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
    settings: InkPassSettings = DEFAULT_INK_SETTINGS,
  ) {
    this.target = InkPass.createTarget(width, height);

    this.composite = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tColor: { value: this.target.textures[0] },
        tInfo: { value: this.target.textures[1] },
        uResolution: { value: new THREE.Vector2(width, height) },
        uThickness: { value: settings.thickness },
        uInkColor: { value: new THREE.Color(settings.color) },
        uFade: { value: new THREE.Vector2(settings.fadeNear, settings.fadeFar) },
        uDepthRange: { value: settings.depthRange.clone() },
        uDepthNoise: { value: settings.depthNoise },
        uNormalRange: { value: settings.normalRange.clone() },
        uIdRange: { value: settings.idRange.clone() },
        uSmoothMargin: { value: settings.smoothMargin },
        uPaper: { value: settings.paper },
        uVignette: { value: settings.vignette },
        uDepthScale: inkLighting.uDepthScale,
        uWarmth: { value: 0.5 },
        uDebug: { value: 0 },
      },
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /**
   * Two colour attachments sharing one depth buffer.
   *
   * `HalfFloatType` rather than the default byte format: the info buffer stores linear
   * depth as a fraction of the far plane, and at 8 bits per channel a 3 km far plane
   * quantises depth into 12 m steps — every surface would read as coplanar with its
   * neighbours and the silhouette detector would find nothing at all.
   */
  private static createTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.textures[0].name = 'ink.color';
    target.textures[1].name = 'ink.info';
    return target;
  }

  setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
    this.composite.uniforms.uResolution.value.set(width, height);
    // setSize keeps the same texture objects, but re-point the samplers anyway so a future
    // change to reallocate on resize cannot silently leave the composite reading a
    // disposed texture.
    this.composite.uniforms.tColor.value = this.target.textures[0];
    this.composite.uniforms.tInfo.value = this.target.textures[1];
  }

  /**
   * Kept for callers that want to notify the pass of a camera change. The depth encoding
   * no longer depends on the camera planes (see DEPTH_CODEC), so this is a no-op that
   * exists so a future encoding change has an obvious place to live.
   */
  setCameraPlanes(_near: number, _far: number): void {}

  /** Runtime access for the settings panel and the day cycle. */
  get uniforms(): Record<string, THREE.IUniform> {
    return this.composite.uniforms;
  }

  /**
   * Show one detector's raw contribution instead of the composited frame.
   *
   * `all` puts depth in red, normal in green and material id in blue, which answers "which
   * test is drawing this line" in one look — the question that is otherwise unanswerable,
   * because all three produce identical ink.
   */
  setDebug(mode: 'off' | 'all' | 'depth' | 'normal' | 'id' | 'rawDepth' | 'rawNormal'): void {
    const modes = { off: 0, all: 1, depth: 2, normal: 3, id: 4, rawDepth: 5, rawNormal: 6 };
    this.composite.uniforms.uDebug.value = modes[mode];
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const previousTarget = this.renderer.getRenderTarget();

    // `renderer.info` resets itself at the start of every `render()` call, so with two
    // calls per frame the stats a caller reads afterwards describe the fullscreen quad and
    // nothing else — "1 draw call, 2 triangles" for an island with a hundred buildings on
    // it. Taking over the reset makes the counters cover the whole frame.
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();

    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);

    this.renderer.setRenderTarget(previousTarget);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.target.dispose();
    this.composite.dispose();
    this.quad.geometry.dispose();
  }
}
