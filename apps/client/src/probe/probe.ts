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
}

/**
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
  /** The south quay at eye level — warehouses, stalls, boats. */
  quay: { eye: [-20, 7, 88], target: [6, 4, 68], fov: 55 },
  /** The plaza stage from the audience's position. */
  plaza: { eye: [64, 12.5, 49], target: [68, 10, 26], fov: 50 },
  /** The Old Street, looking down the row of townhouses. */
  street: { eye: [64, 13.5, -12], target: [64, 11, -48], fov: 55 },
  /** The shrine approach, through the torii. */
  shrine: { eye: [-36, 15, 34], target: [-78, 13.5, 38], fov: 50 },
  /** The summit court, looking back down at the island. */
  summit: { eye: [17, 30, 15], target: [0, 26, -3], fov: 55 },
  /** The lighthouse cape against the sky. */
  lighthouse: { eye: [-44, 18, -54], target: [-64, 20, -37], fov: 50 },
  /** The teahouse on the plaza's quiet side. */
  teahouse: { eye: [66, 13, 30], target: [79, 10.5, 34], fov: 52 },
  /** The north fishing harbour, from the quay approach looking out over the bay. */
  north: { eye: [20, 10, -50], target: [-16, 3, -82], fov: 55 },
  /** Sunset beach, low and level with the water. */
  beach: { eye: [30, 5, 106], target: [56, 3, 88], fov: 55 },
  /**
   * A close look at one character, for reviewing the rig. Framed on the plaza — the world
   * origin is the summit, and a camera at eye height there is buried inside the terrain.
   */
  figure: { eye: [66.6, 9.5, 43.2], target: [64, 9, 40], fov: 38 },
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
