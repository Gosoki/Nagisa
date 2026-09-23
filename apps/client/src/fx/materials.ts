/**
 * Materials for the effects layer, and why they are not ink materials.
 * ====================================================================
 *
 * The world is drawn in two passes (see `docs/RENDERING.md`): a geometry pass that writes a
 * colour target whose **alpha is the material id**, plus an info target holding depth,
 * normal and the outline mask; then a composite that draws pen lines wherever those
 * disagree between neighbouring pixels.
 *
 * Most of what the games put in the world is not a surface. A spark, a lighthouse beam and
 * a lantern's halo are *light*; a ripple, a fishing line and a countdown arc are *marks laid
 * on the drawing*. None of them should be outlined, and — the part that is easy to get
 * wrong — none of them may disturb the outlines of what is behind them. Two things would:
 *
 * - **The material id.** Ordinary alpha blending blends the colour target's alpha too, so a
 *   translucent spark would write a fractional id over the sky, and the id detector would
 *   ring every spark with ink. So the alpha channel is blended with factors (0, 1): the id
 *   underneath is kept exactly as it was.
 * - **The info target.** Every draw writes both targets. Each writes `vec4(0)` there, and
 *   because the colour factors are `SRC_ALPHA`-weighted — and blending is per attachment, on
 *   that attachment's own alpha — a zero alpha means depth, normal and mask pass through
 *   untouched. The contour pass never learns the effect was there.
 *
 * The result is that effects add light to (or lay a tint over) the finished drawing's
 * colours, and everything the contour pass sees is the island behind them. Depth *test*
 * stays on so a hill still hides a firework; depth *write* is off so nothing hides behind
 * a halo.
 *
 * ### Blends
 *
 * - `add` — light. `rgb += colour · alpha`. Sparks, beams, halos.
 * - `over` — a mark. `rgb = mix(rgb, colour, alpha)`. Ripples, lines, droplets, glyphs.
 * - `unline` — draws nothing, and clears the outline mask under itself. Because an `over`
 *   mark leaves the info target alone, the contour pass still draws the pen lines of
 *   whatever is *behind* it — on top of it. For a ripple that is right; for a name plate or
 *   a speech bubble it puts a roof's edge through the middle of the text. Drawn under a
 *   label with the label's own coverage in `gInfo.a`, this scales the mask down to nothing
 *   there (alpha factors 0 and 1 − src), while both targets' colours and the colour target's
 *   material id pass through untouched. One alpha channel cannot be both the id and a label's
 *   coverage, which is why it takes a draw of its own rather than a better blend.
 */

import * as THREE from 'three';

export type FxBlend = 'add' | 'over' | 'unline';

/** The two outputs every effect shader declares: see the header for why `gInfo` is zero. */
export const FX_OUTPUTS = /* glsl */ `
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gInfo;
`;

/**
 * Drawing-buffer height, px, shared by every effect that sizes points in metres.
 *
 * Point sprites are sized in pixels, so a spark that should be half a metre across has to
 * know how many pixels a metre is at its distance. Written from `onBeforeRender` of the
 * objects that need it — the only place the effects layer sees the renderer.
 */
export const fxViewport = { value: 760 };

const viewport = new THREE.Vector4();

/** An `onBeforeRender` that keeps {@link fxViewport} current. Allocation-free. */
export function trackViewport(renderer: THREE.WebGLRenderer): void {
  renderer.getCurrentViewport(viewport);
  fxViewport.value = viewport.w;
}

/** Build an effect material. Always transparent (drawn after the opaque island). */
export function fxMaterial(options: {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
  blend: FxBlend;
  side?: THREE.Side;
  depthTest?: boolean;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: options.vertexShader,
    fragmentShader: options.fragmentShader,
    uniforms: options.uniforms,
    side: options.side ?? THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: options.depthTest ?? true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: options.blend === 'unline' ? THREE.ZeroFactor : THREE.SrcAlphaFactor,
    blendDst: options.blend === 'add' || options.blend === 'unline' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: options.blend === 'unline' ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
  });
}

// ---------------------------------------------------------------------------
// Ballistic points
// ---------------------------------------------------------------------------

/**
 * Particles whose whole flight is a closed-form function of time, evaluated in the vertex
 * shader: fireworks, rockets and splash droplets.
 *
 * Each vertex is one sample of one particle. `position` carries the particle's launch
 * velocity (not a position — the attribute name is three's, and reusing it spares a dummy
 * buffer); `aLag` says how far behind the particle's head in time this sample is, so a
 * particle drawn as five samples at lags 0…0.2 s is a streak along its own path; `aDelay`
 * holds a particle back (the second ring of a double burst); `aTone` picks between two
 * colours.
 *
 * Motion under gravity `g` with linear drag `k` has an exact solution,
 * `p(t) = o + g·t/k + (v₀ − g/k)(1 − e^(−kt))/k`, so nothing is integrated on the CPU and a
 * burst costs a handful of uniform writes a frame however many sparks it has. A willow's
 * drooping trails are not modelled at all: they are what that formula draws when drag is
 * high and the lag samples are spread out.
 */
export const BALLISTIC_VERTEX = /* glsl */ `
uniform vec3 uOrigin;
uniform mat3 uBasis;
uniform float uSpeed;
uniform float uTime;
uniform float uLife;
uniform float uGravity;
uniform float uDrag;
uniform float uSize;
uniform float uFade;
uniform float uMaxLag;
uniform float uViewport;

in float aLag;
in float aDelay;
in float aTone;

out float vAlpha;
out float vTone;

void main() {
  float head = uTime - aDelay;
  float t = head - aLag;
  vTone = aTone;
  if (t < 0.0 || head > uLife) {
    // Not born yet, or its head has died: park it outside the clip volume.
    vAlpha = 0.0;
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 v0 = uBasis * position * uSpeed;
  vec3 g = vec3(0.0, uGravity, 0.0);
  vec3 p;
  if (uDrag < 0.01) {
    p = uOrigin + v0 * t + 0.5 * g * t * t;
  } else {
    p = uOrigin + g * (t / uDrag) + (v0 - g / uDrag) * ((1.0 - exp(-uDrag * t)) / uDrag);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float age = head / uLife;
  float lag = uMaxLag > 0.0 ? aLag / uMaxLag : 0.0;
  vAlpha = pow(1.0 - age, uFade) * (1.0 - lag * 0.8);
  float size = uSize * (0.6 + 0.4 * (1.0 - age)) * (1.0 - lag * 0.45);
  gl_PointSize = clamp(size * projectionMatrix[1][1] * uViewport * 0.5 / max(0.5, -mv.z), 1.0, 40.0);
}
`;

export const BALLISTIC_FRAGMENT = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
uniform float uCore;

in float vAlpha;
in float vTone;

${FX_OUTPUTS}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = (1.0 - smoothstep(0.3, 1.0, d)) * vAlpha * uOpacity;
  if (a < 0.004) discard;
  vec3 colour = mix(uColorA, uColorB, vTone);
  // A hotter centre, so a spark reads as a point of light rather than a coloured dot.
  colour = mix(colour, vec3(1.0), (1.0 - smoothstep(0.0, 0.3, d)) * uCore);
  gColor = vec4(colour, a);
  gInfo = vec4(0.0);
}
`;

/** Uniforms for one ballistic system. Each pooled system owns its own set. */
export function ballisticUniforms(): Record<string, THREE.IUniform> {
  return {
    uOrigin: { value: new THREE.Vector3() },
    uBasis: { value: new THREE.Matrix3() },
    uSpeed: { value: 1 },
    uTime: { value: 0 },
    uLife: { value: 1 },
    uGravity: { value: -9.8 },
    uDrag: { value: 0 },
    uSize: { value: 0.3 },
    uFade: { value: 1 },
    uMaxLag: { value: 0 },
    uViewport: fxViewport,
    uColorA: { value: new THREE.Color() },
    uColorB: { value: new THREE.Color() },
    uOpacity: { value: 1 },
    uCore: { value: 0 },
  };
}

/** Pack particle samples into a geometry the ballistic shader draws. */
export function ballisticGeometry(samples: {
  velocity: number[];
  lag: number[];
  delay: number[];
  tone: number[];
}): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(samples.velocity, 3));
  geometry.setAttribute('aLag', new THREE.Float32BufferAttribute(samples.lag, 1));
  geometry.setAttribute('aDelay', new THREE.Float32BufferAttribute(samples.delay, 1));
  geometry.setAttribute('aTone', new THREE.Float32BufferAttribute(samples.tone, 1));
  return geometry;
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

/**
 * A drawn circle on a flat quad: the bell's ripples, a splash's ring on the water, the quiz
 * countdown. Computed per fragment from the distance to the centre, so the stroke keeps a
 * constant width in metres however far the ring has grown, and wanders a little in radius
 * and weight the way a brush circle does.
 *
 * `uArc` < 1 draws only that fraction of the circle, starting from `uArcStart` — which is
 * all a countdown needs.
 */
const RING_VERTEX = /* glsl */ `
out vec2 vPlane;
void main() {
  vPlane = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uRadius;
uniform float uWidth;
uniform float uScale;
uniform float uWobble;
uniform float uSeed;
uniform float uArc;
uniform float uArcStart;

in vec2 vPlane;

${FX_OUTPUTS}

void main() {
  vec2 p = vPlane * uScale;
  float d = length(p);
  float angle = atan(p.y, p.x);
  float r = uRadius + uWobble * (sin(angle * 3.0 + uSeed) * 0.6 + sin(angle * 7.0 + uSeed * 2.3) * 0.4);
  float halfWidth = uWidth * (0.4 + 0.12 * sin(angle * 2.0 + uSeed * 1.7));
  float aa = fwidth(d) * 1.2;
  float line = 1.0 - smoothstep(halfWidth, halfWidth + aa, abs(d - r));
  if (uArc < 0.999) {
    float along = fract((angle - uArcStart) / 6.2831853);
    if (along > uArc) discard;
  }
  float a = line * uOpacity;
  if (a < 0.003) discard;
  gColor = vec4(uColor, a);
  gInfo = vec4(0.0);
}
`;

/** A unit quad in the xz plane; a ring mesh scales it to its largest radius. */
export function ringQuad(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
}

/** A ring material with its own uniforms. `uScale` must match the mesh's xz scale. */
export function ringMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return fxMaterial({
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    blend: 'over',
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
      uRadius: { value: 1 },
      uWidth: { value: 0.1 },
      uScale: { value: 1 },
      uWobble: { value: 0.04 },
      uSeed: { value: 0 },
      uArc: { value: 1 },
      uArcStart: { value: 0 },
    },
  });
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const LINE_VERTEX = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LINE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
${FX_OUTPUTS}
void main() {
  gColor = vec4(uColor, uOpacity);
  gInfo = vec4(0.0);
}
`;

/** A one-pixel ink line: a fishing line is a hairline, which is exactly what GL lines are. */
export function lineMaterial(color: THREE.ColorRepresentation, opacity: number): THREE.ShaderMaterial {
  return fxMaterial({
    vertexShader: LINE_VERTEX,
    fragmentShader: LINE_FRAGMENT,
    blend: 'over',
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
  });
}

// ---------------------------------------------------------------------------
// Glow points
// ---------------------------------------------------------------------------

const GLOW_VERTEX = /* glsl */ `
uniform float uSize;
uniform float uViewport;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * projectionMatrix[1][1] * uViewport * 0.5 / max(0.5, -mv.z), 1.0, 96.0);
}
`;

const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
${FX_OUTPUTS}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  // A soft falloff with no edge at all: a halo is light in the air, not a disc.
  float a = pow(max(0.0, 1.0 - d), 2.2) * uStrength;
  if (a < 0.004) discard;
  gColor = vec4(uColor, a);
  gInfo = vec4(0.0);
}
`;

/** Additive soft halos at arbitrary points (`position` is world space), `size` metres across. */
export function glowPointsMaterial(color: THREE.ColorRepresentation, size: number): THREE.ShaderMaterial {
  return fxMaterial({
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    blend: 'add',
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: 0 },
      uSize: { value: size },
      uViewport: fxViewport,
    },
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Exponential approach, frame-rate independent: the one easing every fade here uses. */
export function approach(current: number, target: number, dt: number, rate: number): number {
  return current + (target - current) * (1 - Math.exp(-dt * rate));
}

/** Hermite smoothstep on [edge0, edge1]. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
