/**
 * Shared GLSL chunks for the ink renderer.
 * ========================================
 *
 * Small, reusable pieces of shader source that both the scene materials and the
 * post-processing passes need. Keeping them here rather than pasting them into each
 * shader matters more than usual in this renderer: the geometry pass *encodes* normals and
 * depth into a buffer and the outline pass *decodes* them, so the two must agree exactly.
 * A one-line divergence between an encoder and its decoder produces outlines that are
 * subtly wrong everywhere and obviously wrong nowhere.
 *
 * Everything here is written for **GLSL ES 3.00** (`THREE.GLSL3`), which the renderer
 * requires anyway for multiple render targets.
 */

/**
 * Spheremap transform for view-space normals: 3 floats → 2, and back.
 *
 * Chosen over the obvious `n * 0.5 + 0.5` because two channels are all the info buffer
 * has to spare (r holds depth, a holds the outline mask) and because this encoding keeps
 * its precision where it is needed — near the silhouette, where the normal turns away from
 * the camera and where the outline detector is looking.
 *
 * Only valid for normals in *view* space, which is what the geometry pass writes.
 */
export const NORMAL_CODEC = /* glsl */ `
vec2 encodeNormalSpheremap(vec3 n) {
  float f = sqrt(8.0 * n.z + 8.0);
  return n.xy / f + 0.5;
}

vec3 decodeNormalSpheremap(vec2 enc) {
  vec2 fenc = enc * 4.0 - 2.0;
  float f = dot(fenc, fenc);
  float g = sqrt(1.0 - f * 0.25);
  return vec3(fenc * g, 1.0 - f * 0.5);
}
`;

/**
 * Depth helpers.
 *
 * The info buffer stores view distance as a **fraction of a fixed reference range**
 * (`uDepthScale`, a few hundred metres), *not* as a fraction of the camera's far plane and
 * *not* inverted. Both of those details are load-bearing, and getting either wrong
 * produces the same distinctive artefact.
 *
 * **Linear, not hyperbolic.** The detector's threshold means "how many metres apart are
 * these two surfaces". The hardware depth buffer's hyperbolic distribution would make that
 * threshold mean something different at every distance, so contours that looked right on a
 * lantern beside you would vanish on a lighthouse across the bay.
 *
 * **Not inverted, and not scaled by the far plane.** The info buffer is half-float, whose
 * precision is *relative*: an ULP near 1.0 is 2⁻¹¹ ≈ 0.0005, while near 0.05 it is 2⁻¹⁶ ≈
 * 0.000015 — thirty times finer. An earlier version stored `1 − dist/far` with a 3.6 km far
 * plane, which parked every value in the scene up near 1.0 and quantised depth into 1.8 m
 * steps. The detector faithfully drew a line at every step boundary, and the mountain came
 * out looking like a contour map. Storing `dist/500` instead puts nearby geometry down in
 * the fine end of the float, where a 20 m surface quantises at about 6 mm.
 *
 * Anything beyond `uDepthScale` clamps to 1. That is harmless: interior contours are faded
 * out well before then (see `InkPassSettings.fadeFar`), so the only thing living in the
 * clamped range is open sea, which is not contoured at all.
 */
export const DEPTH_CODEC = /* glsl */ `
float encodeLinearDepth(float viewZ, float scale) {
  return clamp(-viewZ / scale, 0.0, 1.0);
}

float decodeLinearDepth(float stored, float scale) {
  return stored * scale;
}
`;

/**
 * Value noise and a paper-grain field, evaluated in screen space.
 *
 * This is what stops the flat fills from looking like flat fills. The reference product
 * gets its tooth from painted texture maps; we have no texture budget for a hundred
 * hand-painted atlases, so the tooth is generated per-pixel instead: a low-amplitude,
 * high-frequency field that rides on top of every surface exactly as paper grain rides
 * under a wash.
 *
 * Deliberately *screen*-space rather than world-space. Paper does not move when the
 * subject moves; a grain locked to the geometry reads as dirt on the model, a grain
 * locked to the frame reads as the medium the frame is drawn on.
 */
export const PAPER_NOISE = /* glsl */ `
float inkHash(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

float inkValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(inkHash(i), inkHash(i + vec2(1.0, 0.0)), u.x),
    mix(inkHash(i + vec2(0.0, 1.0)), inkHash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

/** Two octaves of grain, centred on 0. Range roughly [-0.5, 0.5]. */
float paperGrain(vec2 fragCoord) {
  float a = inkValueNoise(fragCoord * 0.42);
  float b = inkValueNoise(fragCoord * 1.31 + 17.0);
  return (a * 0.66 + b * 0.34) - 0.5;
}

/**
 * Diagonal pen hatching, in screen space, with a wobbling line so it reads as drawn
 * rather than printed. \`density\` is lines per pixel; \`phase\` shifts the set so two
 * surfaces meeting at an edge do not share a stroke.
 */
float penHatch(vec2 fragCoord, float density, float phase) {
  vec2 rotated = vec2(fragCoord.x * 0.7071 + fragCoord.y * 0.7071, -fragCoord.x * 0.7071 + fragCoord.y * 0.7071);
  float wobble = inkValueNoise(rotated * 0.06) * 3.4;
  float coord = (rotated.x + wobble + phase) * density;

  // Nyquist fade. One stroke period is 1.0 in \`coord\`, so once a pixel spans more than
  // about a third of a period the pattern cannot be represented and sampling it produces
  // interference rather than hatching. See the note above the function.
  float perPixel = fwidth(coord);
  float resolvable = 1.0 - smoothstep(0.22, 0.5, perPixel);
  if (resolvable <= 0.001) return 0.0;

  // The stroke edge softens in proportion to how fast the pattern is moving, so hatching
  // seen edge-on blurs out instead of stair-stepping.
  float soft = clamp(perPixel * 3.0, 0.12, 0.55);
  return smoothstep(0.35 - soft, 0.35 + soft, sin(coord * 6.2831853)) * resolvable;
}

/**
 * A slow, low-frequency offset applied to where the contour detector takes its samples.
 *
 * A screen-space edge detector produces a mathematically exact line: one pixel wide,
 * following the geometry to the pixel, dead straight wherever the geometry is. That is the
 * biggest single tell that a "hand-drawn" renderer is not hand-drawn — a person's line
 * wanders, and never runs perfectly true along a wall.
 *
 * Displacing the sample point by a smooth noise field before detection makes the line
 * wander with it. Two octaves: the low one bows a stroke over tens of pixels, the high one
 * gives it a little tooth. Amplitude is around a pixel — enough to break the
 * ruler-straightness, not enough to detach the line from what it describes.
 */
vec2 inkStrokeWobble(vec2 fragCoord, float amplitude) {
  float a = inkValueNoise(fragCoord * 0.021 + 3.7);
  float b = inkValueNoise(fragCoord * 0.021 + 41.3);
  float c = inkValueNoise(fragCoord * 0.062 + 11.9);
  float d = inkValueNoise(fragCoord * 0.062 + 77.1);
  return vec2((a - 0.5) * 0.78 + (c - 0.5) * 0.22, (b - 0.5) * 0.78 + (d - 0.5) * 0.22) * amplitude * 2.0;
}
`;

/**
 * `fit`: remap a value from one range to another, clamped. The outline detector uses it
 * repeatedly to turn raw per-channel variation into a 0–1 contribution with a threshold
 * and a soft margin, so it is worth having as a named function rather than as five
 * inlined smoothsteps.
 */
export const FIT = /* glsl */ `
float fit(float value, float inMin, float inMax, float outMin, float outMax) {
  float t = clamp((value - inMin) / max(1e-6, inMax - inMin), 0.0, 1.0);
  return outMin + t * (outMax - outMin);
}
`;
