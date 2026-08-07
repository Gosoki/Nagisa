/**
 * The sea surface, once.
 * ======================
 *
 * Two crossed sine trains. The ocean mesh displaces its vertices by them in a vertex
 * shader; the boats have to ride the same surface on the CPU. Those are two evaluations of
 * one thing, and the moment they are written twice they are a bug waiting for someone to
 * change an amplitude.
 *
 * So the coefficients live here as data, the GLSL is *generated* from them, and
 * {@link waveHeight} evaluates the identical expression in TypeScript. Change a number and
 * both sides move together, because there is only one number.
 *
 * ### Why the boats need this at all
 *
 * Every floating landmark was placed at `y = max(0, groundHeight)` — sea level, for anything
 * over water — and left there. The sea, meanwhile, swings through ±1.12 m as the crests pass.
 * A hull sitting on a fixed 0 m is therefore under water for a good fraction of every cycle,
 * which is exactly what a player reported: *"船有的时候会被海水完全淹没"* — the boats are
 * sometimes completely swallowed, all of them.
 *
 * The obvious patch is to raise them a metre. That trades a boat that sinks for a boat that
 * hovers, and it would still sink whenever two trains happen to add. Riding the surface is
 * both correct and the better picture: boats at anchor move, and a harbour where nothing
 * moves reads as a diorama.
 *
 * ### Not simulation
 *
 * This is scenery. The server has no opinion about wave height, nothing collides with the
 * sea, and a client that renders waves differently (or not at all — see `damp` and the
 * quality tier's `animatedWater`) is not out of sync with anything. That is why this lives in
 * the client and not in `@nagisa/shared`.
 */

/**
 * One sine train: `sin(dot(axis, p) * frequency + t * speed) * amplitude`.
 *
 * The axes are the three the ocean has always used — one along x, one along z, and a long
 * diagonal swell that carries most of the amplitude.
 */
interface Train {
  /** Which way the train runs: `[x, z]`, applied as a dot product with the position. */
  readonly axis: readonly [number, number];
  readonly frequency: number;
  /** Radians per second. Negative runs the train the other way. */
  readonly speed: number;
  readonly amplitude: number;
}

const TRAINS: readonly Train[] = [
  { axis: [1, 0], frequency: 0.055, speed: 0.9, amplitude: 0.34 },
  { axis: [0, 1], frequency: 0.041, speed: -0.7, amplitude: 0.28 },
  { axis: [1, 1], frequency: 0.017, speed: 0.45, amplitude: 0.5 },
];

/** Peak displacement if every train crests at once, metres. Nothing may float below this. */
export const WAVE_AMPLITUDE = TRAINS.reduce((sum, t) => sum + t.amplitude, 0);

/**
 * Where the waves stop, metres from the origin.
 *
 * The ocean damps them out toward the horizon so it stays a clean line — a rippling horizon
 * reads as a bug rather than as sea — and anything riding the surface has to damp identically
 * or it will drift off it far from shore.
 */
const DAMP_NEAR = 120;
const DAMP_FAR = 900;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Height of the undamped sea surface at a point, metres above mean sea level. */
export function waveHeight(x: number, z: number, t: number): number {
  let h = 0;
  for (const train of TRAINS) {
    h += Math.sin((x * train.axis[0] + z * train.axis[1]) * train.frequency + t * train.speed) * train.amplitude;
  }
  return h;
}

/** The distance damping the ocean shader applies. 1 inshore, 0 at the horizon. */
export function waveDamping(x: number, z: number): number {
  return 1 - smoothstep(DAMP_NEAR, DAMP_FAR, Math.hypot(x, z));
}

/** Height of the sea surface as actually drawn, damping included. */
export function seaSurfaceAt(x: number, z: number, t: number): number {
  return waveHeight(x, z, t) * waveDamping(x, z);
}

/**
 * The GLSL the ocean's vertex shader uses, generated from {@link TRAINS} so the two
 * evaluations cannot drift apart.
 *
 * Emitted as literals rather than uniforms: these are compile-time constants of the surface,
 * the shader is rebuilt whenever the module is, and a uniform per coefficient would be nine
 * more things to keep in step for no benefit.
 */
export const WAVE_GLSL = `
float waveHeight(vec2 p, float t) {
  float w = 0.0;
${TRAINS.map(
  (train) =>
    `  w += sin(dot(p, vec2(${train.axis[0].toFixed(1)}, ${train.axis[1].toFixed(1)})) * ${train.frequency} + t * ${train.speed}) * ${train.amplitude};`,
).join('\n')}
  return w;
}

float waveDamping(vec2 p) {
  return 1.0 - smoothstep(${DAMP_NEAR.toFixed(1)}, ${DAMP_FAR.toFixed(1)}, length(p));
}
`;
