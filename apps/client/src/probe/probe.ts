/**
 * Render probe.
 * =============
 *
 * A development entry point that boots the real island, the real materials and the real
 * ink pass with no interface, no netcode and no input, parks the camera at a named
 * viewpoint, and reports when it is ready.
 *
 * It exists because the failure modes of a stylised renderer are *visual*. A shader that
 * compiles, a material that batches and a contour pass that runs at 60 fps can still
 * produce a picture with the outlines inverted, the shadow tone reading as mud, or the
 * ocean drawn over the island. None of that is visible to a type checker or a unit test,
 * and all of it is obvious in one screenshot.
 *
 * `tools/shot.mjs` drives this page in headless Chromium and writes PNGs, so the art
 * direction can be reviewed as pictures on a machine with no display.
 *
 * The probe deliberately uses the *production* modules rather than simplified stand-ins.
 * A probe that renders its own approximation of the island tells you nothing about the
 * island.
 */

import * as THREE from 'three';
import { ISLAND_EXTENT, SUMMIT, ZONES, activeMap, heightAt, resolveMapId, type ZoneId } from '@nagisa/shared';
import { Renderer } from '../engine/renderer.js';
import { settingsFor, type QualityTier } from '../engine/quality.js';
import { Island } from '../world/island.js';
import { Character } from '../character/character.js';

/**
 * Named camera positions.
 *
 * Each is authored as an eye point and a look-at target in world space, chosen to frame
 * something the art direction has to get right: architecture against sky, a crowd at
 * human height, the whole island in silhouette.
 */
interface Viewpoint {
  eye: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view. Wider for landscapes, tighter for architecture. */
  fov?: number;
  /**
   * Which way is up in frame. Only meaningful looking straight down, where `lookAt` has no
   * roll to derive — `-z` puts north at the top, matching the minimap and the plan diagrams.
   */
  up?: [number, number, number];
  /** Skip the crowd. A plan view wants to see the ground, not nine people standing on it. */
  empty?: boolean;
}

/**
 * A plan view: straight down over a place, framing `span` metres, north up.
 *
 * The camera stays a perspective one — the renderer's ink pass, its shadow box and its
 * adaptive resolution all read `renderer.camera`, and swapping in an orthographic camera to
 * get parallel projection would mean auditing all three. From 340 m up a `span`-metre window
 * subtends a few degrees, and the convergence across it is small enough that a roof ridge
 * still reads as parallel to the wall under it, which is all these are for.
 *
 * They exist because a layout defect is a *plan* defect: a building in the road, a door on
 * the wrong side, two roofs interpenetrating. From eye level the first is hidden by the
 * second and from an oblique aerial the roofs hide the ground. `tools/plan-diagram.mjs`
 * draws the same thing from the data; this is the check that the data and the geometry agree.
 */
function plan(cx: number, cz: number, ground: number, span: number): Viewpoint {
  const altitude = 340;
  return {
    eye: [cx, ground + altitude, cz],
    target: [cx, ground, cz],
    fov: (2 * Math.atan(span / 2 / altitude) * 180) / Math.PI,
    up: [0, 0, -1],
    empty: true,
  };
}

/**
 * These are coordinates in a world that gets re-laid, so they go stale: a viewpoint whose
 * eye ends up inside a wall renders a picture of plaster and tells you nothing. When a zone
 * is re-composed, re-render its viewpoint and move the camera to match — `npm run plans`
 * shows where the ground is clear.
 *
 * Every eye height below is authored against Nagisa Island's terraces — a camera 4 m above
 * the plaza is 12 m up, because the plaza is at 8. When the island's relief was halved these
 * all moved with it; a viewpoint left at the old height ends up in the sky, or buried.
 */
const VIEWPOINTS: Record<string, Viewpoint> = {
  /** The whole island from the south-east, high up. The silhouette test. */
  island: { eye: [190, 140, 215], target: [0, 10, 0], fov: 42 },
  /** Arrival: standing at the end of the ferry pier looking up at the island. */
  arrival: { eye: [0, 5, 104], target: [4, 14, 24], fov: 55 },
  /**
   * The default third-person framing, on the quay. Matches `CameraRig`'s `default` spec
   * (10.5 m back, 3.4 m up) so anything that only shows up at the angle players actually
   * play at can be reviewed here rather than through the whole-app smoke test.
   */
  gameplay: { eye: [0, 9.5, 85], target: [0, 3.7, 74], fov: 50 },
  /** The south quay at eye level — warehouses, stalls, boats. Standing on the quay road. */
  quay: { eye: [24.9, 6.4, 72.2], target: [-3.7, 4, 80.2], fov: 55 },
  /** The plaza stage from the audience's position, in front of it where the crowd forms. */
  plaza: { eye: [52.1, 12, 43.6], target: [67, 10.5, 53.7], fov: 50 },
  /** The Old Street, standing in the road and looking down between the two rows. */
  street: { eye: [72.5, 13, -19.5], target: [52.5, 10.5, -54], fov: 55 },
  /** The shrine approach, through the torii. */
  shrine: { eye: [-36, 15, 34], target: [-78, 13.5, 38], fov: 50 },
  /** The summit court, looking back down at the island. */
  summit: { eye: [17, 30, 15], target: [0, 26, -3], fov: 55 },
  /** The lighthouse cape against the sky. */
  lighthouse: { eye: [-46, 18, -52], target: [-72, 20, -43], fov: 50 },
  /** The teahouse on the plaza's quiet side. */
  teahouse: { eye: [69, 12, 8], target: [85, 10.5, 18.5], fov: 52 },
  /** The north fishing harbour, from the quay approach looking out over the bay. */
  north: { eye: [20, 10, -50], target: [-16, 3, -82], fov: 55 },
  /** Sunset beach, low and level with the water. */
  beach: { eye: [30, 5, 106], target: [56, 3, 88], fov: 55 },
  /**
   * The mountain, raked from above the sea with nothing built in frame.
   *
   * This one is about the *ground*. Faceting in the height field, terrace steps and the
   * seams where a blend ring meets natural slope are invisible from inside a village and
   * obvious along a silhouette, so there needs to be a viewpoint that shows only silhouette.
   */
  slopes: { eye: [138, 66, 104], target: [0, 12, 0], fov: 36 },
  /**
   * A close look at one character, for reviewing the rig. Framed on the plaza — the world
   * origin is the summit, and a camera at eye height there is buried inside the terrain.
   */
  figure: { eye: [66.6, 9.5, 43.2], target: [64, 9, 40], fov: 38 },

  // Plan views — one per terrace, plus the island. See `plan()` above.
  'plan-island': plan(0, 0, 8, 300),
  'plan-summit': plan(0, 0, 26, 76),
  'plan-shrine': plan(-64, 37, 11, 96),
  'plan-street': plan(64, -37, 9, 96),
  'plan-plaza': plan(64, 37, 8, 100),
  'plan-south': plan(0, 74, 2.4, 96),
  'plan-north': plan(0, -74, 2.4, 96),
  'plan-lighthouse': plan(-64, -37, 13, 96),
  'plan-beach': plan(46, 92, 1.6, 72),
};

const params = new URLSearchParams(location.search);

// Before anything reads the terrain field. Same rule and same reason as `main.ts`.
resolveMapId(params.get('map'));

const viewName = params.get('view') ?? 'plaza';
const tier = (params.get('tier') ?? 'high') as QualityTier;
const timeOfDay = Number(params.get('time') ?? 0.42);
const inkEnabled = params.get('ink') !== '0';

const container = document.getElementById('probe') as HTMLElement;
const readout = document.getElementById('readout') as HTMLElement;

/** Set once the world is built and at least one frame has been presented. */
declare global {
  interface Window {
    __probeReady?: boolean;
    __probeInfo?: Record<string, unknown>;
    /** Exposed for `tools/pixel-probe.mjs`, which inspects live material uniforms. */
    __probeScene?: THREE.Scene;
    /**
     * Halts the frame loop. The screenshot tool calls this before capturing even when the
     * page reported itself ready, because Playwright waits for the compositor to go idle
     * and a running rAF loop never lets it.
     */
    __probeStop?: () => void;
  }
}

async function main(): Promise<void> {
  const quality = settingsFor(tier);
  const renderer = new Renderer(container, quality);
  const island = new Island(quality);
  renderer.scene.add(island.group);
  window.__probeScene = renderer.scene;

  readout.textContent = 'building island…';
  await island.build((value, label) => {
    readout.textContent = `${label} ${(value * 100).toFixed(0)}%`;
  });

  // A small crowd, so the figure rig and its shadows can be reviewed in context. Placed
  // in front of whichever venue the viewpoint is looking at.
  const crowd: Character[] = [];
  // A pack other than Nagisa Island has none of the named viewpoints above — they are that
  // island's coordinates. Fall back to framing whatever is loaded, from its own extent, so
  // `--map lantern-atoll` produces a picture of the atoll rather than of empty sea where the
  // plaza would have been.
  const view =
    VIEWPOINTS[viewName] ??
    (activeMap().id === 'nagisa-island'
      ? VIEWPOINTS.plaza
      : {
          eye: [ISLAND_EXTENT * 1.1, ISLAND_EXTENT * 0.8, ISLAND_EXTENT * 1.25],
          target: [SUMMIT.x, SUMMIT.height * 0.4, SUMMIT.z],
          fov: 42,
        });
  const focusZone = nearestZoneTo(view.target[0], view.target[2]);
  const anchor = ZONES.find((z) => z.id === focusZone) ?? ZONES[0];
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2;
    const radius = 6 + (i % 3) * 3.5;
    // The figure view wants exactly one subject, standing at the point the camera is
    // aimed at; every other view wants a ring of them in front of the venue.
    if (viewName === 'figure' && i > 0) continue;
    if (view.empty) continue;
    const x = viewName === 'figure' ? view.target[0] : anchor.x + Math.cos(angle) * radius;
    const z = viewName === 'figure' ? view.target[2] : anchor.z + Math.sin(angle) * radius;
    const character = new Character({ outfit: i, skin: i % 5, accessory: i % 5 });
    character.root.position.set(x, heightAt(x, z), z);
    character.root.rotation.y = viewName === 'figure' ? Math.PI * 0.15 : angle + Math.PI;
    character.setAnim(i % 3 === 0 ? 1 : 0);
    renderer.scene.add(character.root);
    crowd.push(character);
  }

  // `?debug=ocean` recolours the sea to flat magenta. Diagnostic only, and worth keeping:
  // "is the water there at all" is otherwise very hard to answer from a screenshot, since
  // a mis-shaded sea and a missing sea look identical against a pale sky.
  if (params.get('debug') === 'ocean') {
    const mesh = renderer.scene.getObjectByName('ocean') as THREE.Mesh | null;
    const material = mesh?.material as THREE.ShaderMaterial | undefined;
    if (material?.uniforms) {
      material.uniforms.uShallow.value.setHex(0xff00ff);
      material.uniforms.uMid.value.setHex(0xff00ff);
      material.uniforms.uDeep.value.setHex(0x00ff00);
      material.uniforms.uFoam.value.setHex(0xffff00);
      material.uniforms.uFogDensity = { value: 0 };
    }
  }

  const inkDebug = params.get('inkdebug');
  if (inkDebug) renderer.setInkDebug(inkDebug as Parameters<Renderer['setInkDebug']>[0]);

  // Freeze the day cycle so a screenshot is reproducible.
  island.sky.freeze(timeOfDay);
  if (!inkEnabled && renderer.inkUniforms) {
    renderer.inkUniforms.uThickness.value = 0;
    renderer.inkUniforms.uPaper.value = 0;
  }

  const camera = renderer.camera;
  camera.position.set(...view.eye);
  // Before `lookAt`, which derives the roll from it. Straight down has no natural up.
  if (view.up) camera.up.set(...view.up);
  camera.lookAt(...view.target);
  if (view.fov) {
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
  }

  const focus = new THREE.Vector3(...view.target);
  let elapsed = 0;
  let frames = 0;

  renderer.add({
    order: 0,
    update: (dt: number) => {
      elapsed += dt;
      frames++;
      // The sky's shadow box follows this point, so it must be the thing being looked at
      // rather than the camera — otherwise the shadow map is spent behind the lens.
      island.update(elapsed, Date.now(), focus, dt);
      for (const character of crowd) {
        character.updateLod(camera.position);
        character.update(dt);
      }
      // The camera never moves, so it is re-aimed once and then left alone; re-aiming
      // every frame would fight any future orbit control added here.
      if (frames === 2) {
        const info = renderer.renderer.info;
        window.__probeInfo = {
          view: viewName,
          tier,
          ink: renderer.hasInk,
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          programs: info.programs?.length ?? 0,
          landmarks: island.buildStats.landmarks,
          roadside: island.buildStats.roadsideProps,
          scatter: island.buildStats.scatterInstances,
          terrainMs: island.buildStats.terrainMs,
          ocean: (() => {
            const m = island.ocean.mesh;
            const geo = m.geometry;
            return `visible=${m.visible} inScene=${!!m.parent} verts=${geo.attributes.position?.count ?? 0} idx=${geo.index?.count ?? 0} order=${m.renderOrder} y=${m.position.y}`;
          })(),
        };
        readout.textContent = Object.entries(window.__probeInfo)
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join('\n');
      }
      // Give the pipeline a few frames to settle (adaptive resolution, shadow map, first
      // material compiles), then *stop the loop*.
      //
      // Stopping matters: the screenshot tool runs on SwiftShader, where a frame of this
      // scene takes seconds, and Playwright waits for the compositor to go quiet before
      // capturing. A page that keeps requesting animation frames never goes quiet, so the
      // capture times out on a world that is rendering perfectly well.
      if (frames === 8) {
        renderer.stop();
        window.__probeReady = true;
      }
    },
  });

  window.__probeStop = () => renderer.stop();
  renderer.start();
}

/** Nearest named zone anchor to a point. Used to decide where to stand the crowd. */
function nearestZoneTo(x: number, z: number): ZoneId {
  let best: ZoneId = 'plaza';
  let bestDistance = Infinity;
  for (const zone of ZONES) {
    if (zone.id === 'coast') continue;
    const d = Math.hypot(x - zone.x, z - zone.z);
    if (d < bestDistance) {
      bestDistance = d;
      best = zone.id;
    }
  }
  return best;
}

main().catch((err) => {
  readout.textContent = `probe failed: ${String(err)}\n${(err as Error)?.stack ?? ''}`;
  console.error('[probe]', err, SUMMIT);
  window.__probeReady = true; // Let the screenshot tool capture the failure rather than time out.
});
