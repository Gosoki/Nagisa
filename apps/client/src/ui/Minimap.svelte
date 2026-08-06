<script lang="ts">
  /**
   * Minimap.
   *
   * A small top-down plan of the island with everyone on it: you as a heading arrow, the
   * other players as dots, the named places as labelled markers, and whoever you are
   * following picked out in the accent colour.
   *
   * ### Why it is worth the screen space here
   *
   * `WORLD.md` argues that the island should be legible enough not to need one — the coast
   * road touches every place, so if you can see a path you know where you can go. That is
   * still true for *navigation*. The minimap is not for navigation; it is for **people**.
   * "Where is everyone" and "where is the person I am talking to" are questions the world
   * itself cannot answer from where you are standing, and they are the questions a social
   * world is mostly made of.
   *
   * ### How it draws
   *
   * Two canvases. The terrain is baked **once**, by sampling `isLand`/`heightAt` on a grid
   * — a few thousand calls, ~20 ms, at mount — and thereafter blitted. Only the live layer
   * (players, you, labels) is redrawn per frame, so the per-frame cost is a blit plus a few
   * dozen arcs regardless of how detailed the base is.
   *
   * Baking is keyed to the active map pack, so a different map draws a different island
   * with no further work. See `docs/MAPS.md`.
   */
  import { onMount } from 'svelte';
  import { ISLAND_EXTENT, PATHS, SCENE_COLORS, SUMMIT, ZONES, activeMapId, heightAt, isLand } from '@nagisa/shared';
  import { followTarget, players, selfPose, settings } from '../state/stores.js';

  /** On-screen size, CSS pixels. */
  const SIZE = 168;

  /**
   * Samples per axis for the baked terrain. 192², plus two neighbours per land pixel for
   * the slope shading — on the order of 80k `heightAt` calls, ~70 ms, paid once at mount.
   */
  const BAKE_RES = 192;

  /** World half-extent the map covers. A little past the shore so the island is not clipped. */
  $: EXTENT = ISLAND_EXTENT * 0.82;

  let liveCanvas: HTMLCanvasElement | undefined;
  let base: HTMLCanvasElement | undefined;
  let bakedFor: string | null = null;
  let expanded = false;
  let raf = 0;

  $: enabled = $settings.minimap !== false;

  /** World (x, z) → canvas pixel, for whichever canvas size is current. */
  function project(x: number, z: number, size: number): [number, number] {
    return [((x + EXTENT) / (EXTENT * 2)) * size, ((z + EXTENT) / (EXTENT * 2)) * size];
  }

  /**
   * The map's colour ramp, taken from the world's own palette rather than invented here.
   *
   * A minimap in colours the island does not use reads as a different place — the eye
   * matches a plan to a view by hue long before it matches it by shape. Sampling
   * `SCENE_COLORS` means the two stay in step for free when the palette is retuned, which
   * it is every time the look moves closer to the reference.
   */
  const RAMP = [SCENE_COLORS.sand, SCENE_COLORS.grass, SCENE_COLORS.grassDry, SCENE_COLORS.cliff];

  function rgb(hex: number): [number, number, number] {
    return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
  }

  /** Sample RAMP at t ∈ [0, 1], linearly between the two nearest stops. */
  function rampAt(t: number): [number, number, number] {
    const scaled = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(scaled));
    const f = scaled - i;
    const a = rgb(RAMP[i]);
    const b = rgb(RAMP[i + 1]);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  /**
   * Bake the island silhouette, its paths and its shading.
   *
   * Drawn at BAKE_RES and scaled down by the browser, which gives a free antialiased
   * coastline — sampling `isLand` per output pixel would give a hard, crawling edge.
   */
  function bakeTerrain(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = BAKE_RES;
    canvas.height = BAKE_RES;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(BAKE_RES, BAKE_RES);
    const step = (EXTENT * 2) / BAKE_RES;
    // Normalise height against *this map's* summit. A literal here was fine for one island
    // and produced a uniformly pale plan the moment a 3.5 m atoll was loaded — see docs/MAPS.md.
    const topOfLand = Math.max(1, SUMMIT.height);
    const shallow = rgb(SCENE_COLORS.waterShallow);
    const deep = rgb(SCENE_COLORS.waterDeep);

    for (let j = 0; j < BAKE_RES; j++) {
      const z = -EXTENT + j * step;
      for (let i = 0; i < BAKE_RES; i++) {
        const x = -EXTENT + i * step;
        const o = (j * BAKE_RES + i) * 4;
        const h = heightAt(x, z);

        if (h <= 0 || !isLand(x, z)) {
          // Sea, ramped continuously from the shallows out. A hard two-tone step drew a
          // second coastline a few metres offshore, which is exactly the kind of over-crisp
          // edge the rest of the look is spending effort to avoid.
          const d = Math.min(1, Math.max(0, -h / (topOfLand * 0.55 + 4)));
          image.data[o] = Math.round(shallow[0] + (deep[0] - shallow[0]) * d);
          image.data[o + 1] = Math.round(shallow[1] + (deep[1] - shallow[1]) * d);
          image.data[o + 2] = Math.round(shallow[2] + (deep[2] - shallow[2]) * d);
          image.data[o + 3] = 210;
          continue;
        }

        // Land: hue by elevation band, brightness by slope. The band alone gives a flat
        // stack of contours; the slope term is what makes a ridge look like a ridge, and
        // it is how a drawn map does it too — the shading is the relief, not a legend.
        const [lr, lg, lb] = rampAt(h / topOfLand);
        const gx = heightAt(x + step, z) - h;
        const gz = heightAt(x, z + step) - h;
        // Light from the north-west, matching the world's key light.
        const shade = 1 + Math.max(-0.34, Math.min(0.2, (-gx - gz) / (step * 1.6)));
        image.data[o] = Math.round(Math.min(255, lr * shade));
        image.data[o + 1] = Math.round(Math.min(255, lg * shade));
        image.data[o + 2] = Math.round(Math.min(255, lb * shade));
        image.data[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);

    // Paths on top, so the circulation is readable. Same geometry *and* same colour the
    // world lays them in, so a lane you can see from where you stand is the lane on the map.
    const [pr, pg, pb] = rgb(SCENE_COLORS.path);
    ctx.strokeStyle = `rgba(${pr}, ${pg}, ${pb}, 0.92)`;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const path of PATHS) {
      ctx.beginPath();
      path.points.forEach(([x, z], k) => {
        const px = ((x + EXTENT) / (EXTENT * 2)) * BAKE_RES;
        const pz = ((z + EXTENT) / (EXTENT * 2)) * BAKE_RES;
        if (k === 0) ctx.moveTo(px, pz);
        else ctx.lineTo(px, pz);
      });
      ctx.stroke();
    }
    return canvas;
  }

  function draw(): void {
    raf = requestAnimationFrame(draw);
    if (!liveCanvas || !base) return;

    const size = expanded ? SIZE * 2.2 : SIZE;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (liveCanvas.width !== size * dpr) {
      liveCanvas.width = size * dpr;
      liveCanvas.height = size * dpr;
    }
    const ctx = liveCanvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(base, 0, 0, size, size);

    // Named places. Only labelled when expanded — at 168 px the labels are a smear.
    ctx.font = '500 9px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    for (const zone of ZONES) {
      if (zone.radius > 500) continue; // the coast fallback covers everything
      const [px, pz] = project(zone.x, zone.z, size);
      ctx.fillStyle = 'rgba(38, 34, 30, 0.5)';
      ctx.beginPath();
      ctx.arc(px, pz, 1.8, 0, Math.PI * 2);
      ctx.fill();
      if (expanded) {
        ctx.fillStyle = 'rgba(38, 34, 30, 0.8)';
        ctx.fillText(zone.name, px, pz - 5);
      }
    }

    // Other people.
    const following = $followTarget?.id;
    for (const p of $players) {
      const [px, pz] = project(p.pos[0], p.pos[2], size);
      const isFollowed = p.id === following;
      ctx.fillStyle = isFollowed ? '#C4503A' : 'rgba(38, 34, 30, 0.78)';
      ctx.beginPath();
      ctx.arc(px, pz, isFollowed ? 4 : 2.6, 0, Math.PI * 2);
      ctx.fill();
      if (isFollowed) {
        ctx.strokeStyle = 'rgba(255, 253, 248, 0.9)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
      if (expanded) {
        ctx.fillStyle = 'rgba(38, 34, 30, 0.75)';
        ctx.fillText(p.name, px, pz - 6);
      }
    }

    // You: an arrow, not a dot, because which way you are facing is half of what a map is
    // for. `+z` is south and yaw 0 faces `-z`, so the triangle points at -yaw.
    const [sx, sz] = project(selfPose.x, selfPose.z, size);
    const yaw = selfPose.yaw;
    ctx.save();
    ctx.translate(sx, sz);
    ctx.rotate(-yaw);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.2, 4.5);
    ctx.lineTo(0, 2.4);
    ctx.lineTo(-4.2, 4.5);
    ctx.closePath();
    ctx.fillStyle = '#FFFDF8';
    ctx.strokeStyle = '#26221E';
    ctx.lineWidth = 1.3;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  onMount(() => {
    // Bake lazily and re-bake if the map has changed under us.
    const ensureBase = (): void => {
      const id = activeMapId();
      if (bakedFor !== id) {
        base = bakeTerrain();
        bakedFor = id;
      }
    };
    ensureBase();
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });
</script>

{#if enabled}
  <div class="minimap" class:expanded>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <canvas
      bind:this={liveCanvas}
      style="width:{expanded ? SIZE * 2.2 : SIZE}px;height:{expanded ? SIZE * 2.2 : SIZE}px"
      on:click={() => (expanded = !expanded)}
      role="button"
      tabindex="0"
      aria-label={expanded ? 'Collapse map' : 'Expand map'}
    ></canvas>
    {#if $followTarget}
      <button class="following" on:click={() => followTarget.set(null)}>
        Following {$followTarget.name} · stop
      </button>
    {/if}
  </div>
{/if}

<style>
  .minimap {
    position: absolute;
    top: var(--sp-md);
    right: var(--sp-md);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--sp-xs);
    pointer-events: none;
    z-index: var(--z-hud);
  }

  canvas {
    pointer-events: auto;
    cursor: pointer;
    border-radius: 50%;
    box-shadow: var(--ui-shadow);
    border: 2px solid rgba(255, 253, 248, 0.75);
    transition: width var(--mo-calm), height var(--mo-calm), border-radius var(--mo-calm);
  }

  /* Round when small — it reads as an instrument rather than a window — and square when
     expanded, because at that size the corners hold real island. */
  .expanded canvas {
    border-radius: var(--r-lg);
  }

  .following {
    all: unset;
    pointer-events: auto;
    cursor: pointer;
    background: var(--ui-accent);
    color: #fff;
    font-size: 0.74rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    box-shadow: var(--ui-shadow);
  }

  @media (max-width: 640px) {
    .minimap {
      top: auto;
      bottom: var(--sp-md);
      right: var(--sp-md);
    }
  }
</style>
