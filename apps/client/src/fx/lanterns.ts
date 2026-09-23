/**
 * The lantern walk.
 * =================
 *
 * While a `lanterns` activity is live, everyone attending it carries a paper lantern on a
 * short pole (`Character.setHeldProp`), and after dusk each one has a soft warm halo — so
 * the procession up the shrine path reads, from across the island, as a line of small
 * lights moving through the dark. That line is the whole event; nothing else is drawn.
 *
 * All the halos are one `Points` draw: a vertex per carried lantern, rewritten in place
 * each frame from where the lanterns actually are.
 */

import * as THREE from 'three';
import type { ActivityId, PlayerId, PlayerView } from '@nagisa/shared';
import { inkLighting } from '../engine/ink/ink-material.js';
import type { FxHost } from './index.js';
import { approach, glowPointsMaterial, smoothstep, trackViewport } from './materials.js';

/** Halos drawn at most — one per carrier, and a procession longer than this is a crowd. */
const MAX_HALOS = 64;

/** How often who-carries-what is re-checked against the rigs, seconds. See `reconcile`. */
const RECONCILE_INTERVAL = 1;

export class Lanterns {
  /** Live lantern activities. */
  private live: ReadonlySet<ActivityId> = new Set();
  private players: readonly PlayerView[] = [];
  private selfActivity: ActivityId | null = null;

  /** Who is carrying one right now, by the stores — and as an array, for the frame loop. */
  private carriers = new Set<PlayerId>();
  private carrierList: PlayerId[] = [];
  private reconcileTimer = 0;

  private readonly positions = new THREE.BufferAttribute(new Float32Array(MAX_HALOS * 3), 3);
  private readonly halos: THREE.Points;
  private readonly material = glowPointsMaterial(0xffc680, 0.95);
  private readonly at = new THREE.Vector3();
  private strength = 0;

  constructor(
    private readonly host: FxHost,
    group: THREE.Group,
  ) {
    this.positions.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setDrawRange(0, 0);
    this.halos = new THREE.Points(geometry, this.material);
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 4;
    this.halos.onBeforeRender = trackViewport;
    group.add(this.halos);
  }

  setLive(live: ReadonlySet<ActivityId>): void {
    this.live = live;
    this.recount();
  }

  setPlayers(players: readonly PlayerView[]): void {
    this.players = players;
    this.recount();
  }

  setSelfActivity(activity: ActivityId | null): void {
    this.selfActivity = activity;
    this.recount();
  }

  update(dt: number): void {
    // A figure can be rebuilt under the same id — your own is, when you go ashore — so
    // the stores alone cannot be trusted to have reached every rig. A slow sweep keeps
    // them honest at a cost of one map lookup per carrier per second.
    this.reconcileTimer -= dt;
    if (this.reconcileTimer <= 0) {
      this.reconcileTimer = RECONCILE_INTERVAL;
      this.reconcile(null);
    }

    // The paper already glows with the windows after dusk; the halo only comes out once it
    // is properly dark, and never flicks on.
    const target = this.carrierList.length > 0 ? smoothstep(0.35, 0.85, inkLighting.uNight.value) * 0.5 : 0;
    this.strength = approach(this.strength, target, dt, 1.2);
    this.material.uniforms.uStrength.value = this.strength;
    if (this.strength < 0.01) {
      this.halos.visible = false;
      return;
    }

    const array = this.positions.array as Float32Array;
    let count = 0;
    for (const id of this.carrierList) {
      if (count >= MAX_HALOS) break;
      const at = this.host.characterOf(this.resolve(id))?.lanternPosition(this.at);
      if (!at) continue;
      array[count * 3] = at.x;
      array[count * 3 + 1] = at.y;
      array[count * 3 + 2] = at.z;
      count++;
    }
    this.positions.needsUpdate = true;
    this.halos.geometry.setDrawRange(0, count);
    this.halos.visible = count > 0;
  }

  dispose(): void {
    for (const id of this.carrierList) this.host.characterOf(this.resolve(id))?.setHeldProp(null);
    this.carriers.clear();
    this.carrierList = [];
    this.halos.geometry.dispose();
    this.material.dispose();
    this.halos.removeFromParent();
  }

  /** Work out who should be carrying a lantern, and hand them out or take them back. */
  private recount(): void {
    const next = new Set<PlayerId>();
    if (this.live.size > 0) {
      for (const view of this.players) {
        if (view.activity && this.live.has(view.activity)) next.add(view.id);
      }
      // You are not in `players`; you are `self`, keyed here by a stand-in until the
      // handshake has told us your id.
      if (this.selfActivity && this.live.has(this.selfActivity)) next.add(SELF);
    }
    for (const id of this.carriers) {
      if (!next.has(id)) this.host.characterOf(this.resolve(id))?.setHeldProp(null);
    }
    this.reconcile(next);
  }

  /** Make every carrier's rig hold a lantern. `next`, if given, becomes the carrier set. */
  private reconcile(next: Set<PlayerId> | null): void {
    if (next) {
      this.carriers = next;
      this.carrierList = [...next];
    }
    for (const id of this.carrierList) {
      const character = this.host.characterOf(this.resolve(id));
      if (character && character.heldProp !== 'lantern') character.setHeldProp('lantern');
    }
  }

  private resolve(id: PlayerId): PlayerId {
    return id === SELF ? (this.host.selfId() ?? SELF) : id;
  }
}

/** Stands for "you" in the carrier set, which is keyed before your id may be known. */
const SELF = '\u0000self';
