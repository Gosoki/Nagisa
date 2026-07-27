/**
 * Application composition root.
 * =============================
 *
 * Everything the client is made of is constructed here, wired together, and given to the
 * frame loop. This is the only file that knows about *all* the subsystems — the renderer
 * does not know about the netcode, the netcode does not know about the island, and no
 * subsystem knows about the interface. They meet here and nowhere else.
 *
 * Boot sequence:
 *
 * 1. Detect a quality tier and create the render pipeline.
 * 2. Build the island, publishing progress to the loader. The world is rendering — and
 *    the camera is drifting over the harbour — before the player has typed a name, which
 *    is what makes the entry screen feel like a door rather than a form.
 * 3. Show the entry screen.
 * 4. On entry: open the connection, spawn the character, hand control to the player.
 *
 * The order matters. Connecting *before* the world is built would mean holding a socket
 * open through a ten-second load and arriving as a ghost that other players can see but
 * that cannot yet see them.
 */

import * as THREE from 'three';
import {
  ACTIVITY_TEMPLATES,
  ActivityState,
  INTERACTABLES,
  PROTOCOL,
  Role,
  getZone,
  interactablePosition,
  spawnPoint,
  stagePosition,
  crowdSlot,
  zoneAt,
  type ActivityId,
  type AnnouncementView,
  type Emote,
  type ZoneId,
} from '@nagisa/shared';
import { Renderer, type FrameSubscriber } from './engine/renderer.js';
import { CameraRig } from './engine/camera-rig.js';
import { detectTier, settingsFor, isTouchDevice, type QualityTier } from './engine/quality.js';
import { Island } from './world/island.js';
import { Input } from './input/input.js';
import { LocalPlayer } from './character/local-player.js';
import { RemotePlayers } from './character/remote-players.js';
import { NameTags } from './character/name-tags.js';
import { Connection } from './net/connection.js';
import { WorldSync } from './net/world-sync.js';
import { Ambience } from './audio/ambience.js';
import {
  activities,
  appPhase,
  commands,
  connectionState,
  currentZone,
  interactPrompt,
  loadProgress,
  notify,
  self,
  settings,
  stats,
  stickState,
  zoneAnnounce,
  type SelfState,
  type WorldCommands,
} from './state/stores.js';

/** How close you must be to an interactable's own range for the prompt to appear. */
const INTERACT_CHECK_HZ = 8;

/** How long the zone title card stays up. */
const ZONE_CARD_MS = 3500;

/**
 * The running application.
 *
 * One instance per page. `boot()` is async because building the island is; everything
 * afterwards is synchronous and driven by the frame loop.
 */
export class App {
  private readonly renderer: Renderer;
  private readonly input: Input;
  private readonly camera: CameraRig;
  private readonly island: Island;
  /**
   * Not readonly: the character is rebuilt once, when the player commits to an
   * appearance on the entry screen. Rebuilding is simpler and cheaper than making every
   * mesh and material in the rig mutable for a single use.
   */
  private local: LocalPlayer;
  private readonly remote: RemotePlayers;
  private readonly nameTags: NameTags;
  private readonly ambience = new Ambience();

  private connection: Connection | null = null;
  private sync: WorldSync | null = null;

  /** Wall-clock elapsed since boot, seconds. Drives shader animation. */
  private elapsed = 0;

  /** Accumulator for the interactable proximity check. */
  private interactAccumulator = 0;

  /** Zone the player was in last frame, for change detection. */
  private lastZone: ZoneId | null = null;
  private zoneCardTimer: ReturnType<typeof setTimeout> | null = null;

  /** Scratch, reused every frame. */
  private readonly tmpVec = new THREE.Vector3();

  /** Set once the player has gone ashore; gates the netcode and input. */
  private entered = false;

  /** Interactable currently within range, if any. */
  private nearbyInteractable: { id: string; label: string; kind: 'use' | 'sit' } | null = null;

  constructor(container: HTMLElement) {
    const tier = detectTier();
    const quality = settingsFor(tier);
    settings.update((s) => ({ ...s, quality: tier }));

    this.renderer = new Renderer(container, quality);
    this.input = new Input(container);
    this.camera = new CameraRig(this.renderer.camera, this.input);
    this.island = new Island(quality);
    this.remote = new RemotePlayers(quality.maxDetailedCharacters);
    this.nameTags = new NameTags();

    // The local character exists from the start so the camera has something to frame
    // during the entry screen.
    this.local = new LocalPlayer({ outfit: 0, skin: 0, accessory: 0 }, this.input, this.camera);

    this.renderer.scene.add(this.island.group);
    this.renderer.scene.add(this.remote.group);
    this.renderer.scene.add(this.nameTags.group);
    this.renderer.scene.add(this.local.character.root);

    // Feed the touch stick's screen-space state to the overlay so it can draw the ring.
    // This is the only per-pointer-event value that crosses into the interface.
    this.input.onStickChange = (state) => stickState.set(state);

    this.registerCommands();
    this.subscribeSettings();
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /** Build the world and hand control to the entry screen. */
  async boot(): Promise<void> {
    appPhase.set('loading');

    await this.island.build((value, label) => loadProgress.set({ value, label }));

    // Park the character at a spawn point so the entry-screen camera has a subject and
    // the first thing anyone sees is the harbour, not the origin.
    const spawn = spawnPoint(Math.floor(Math.random() * 6));
    this.local.teleport(spawn.pos[0], spawn.pos[1], spawn.pos[2], spawn.yaw);
    // Hide the placeholder character until an appearance has been chosen.
    this.local.character.root.visible = false;

    this.camera.locked = true;
    this.camera.yaw = spawn.yaw + Math.PI;
    this.camera.snap(this.local.position);

    this.renderer.add(this.frameSubscriber);
    this.renderer.start();

    // One frame of world visible behind the entry card before it fades in.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    appPhase.set('entry');

    this.reportBuildStats();
  }

  /** Publish the one-off build numbers into the stats store. */
  private reportBuildStats(): void {
    const info = this.renderer.renderer.info;
    stats.update((s) => ({
      ...s,
      scatterInstances: this.island.buildStats.scatterInstances,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
    }));
    console.info(
      `[nagisa] island built — terrain ${this.island.buildStats.terrainMs}ms, ` +
        `${this.island.buildStats.landmarks} landmarks, ` +
        `${this.island.buildStats.scatterInstances} scattered instances`,
    );
  }

  // -------------------------------------------------------------------------
  // Entering the world
  // -------------------------------------------------------------------------

  /**
   * Go ashore: adopt the chosen identity, open the connection and give the player
   * control. Idempotent — a double-tap on the entry button must not open two sockets.
   */
  private enterWorld(name: string, appearance: SelfState['appearance']): void {
    if (this.entered) return;
    this.entered = true;

    const trimmed = (name || '').trim().slice(0, PROTOCOL.MAX_NAME_LENGTH);
    const finalName = trimmed || `Visitor ${Math.floor(100 + Math.random() * 900)}`;

    self.update((s) => ({ ...s, name: finalName, appearance }));

    // Rebuild the character now that the appearance is known, preserving the placeholder's
    // position so the camera does not jump when the entry card fades.
    const { x, y, z } = this.local.position;
    const yaw = this.local.yaw;
    this.local.character.dispose();

    const rebuilt = new LocalPlayer(appearance, this.input, this.camera);
    rebuilt.teleport(x, y, z, yaw);
    this.renderer.scene.add(rebuilt.character.root);
    this.local = rebuilt;

    this.connection = new Connection('/ws', (resumeToken) => ({
      t: 'hello',
      protocol: PROTOCOL.VERSION,
      name: finalName,
      appearance,
      resumeToken: resumeToken ?? undefined,
      caps: { mobile: isTouchDevice(), lowMemory: this.renderer.quality.tier === 'low' },
    }));

    this.connection.on('state', (state) => {
      connectionState.set(state);
      if (state === 'connected') notify('Connected', 'good', 1800);
    });

    this.sync = new WorldSync(this.connection, this.remote, rebuilt);
    this.connection.connect();

    // Audio can only start from inside a gesture, and "Go ashore" is one.
    void this.ambience.unlock().then(() => {
      const muted = getSettingsSnapshot().muted;
      this.ambience.setMuted(muted);
    });

    this.camera.locked = false;
    this.camera.snap(rebuilt.position);
    appPhase.set('world');
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * The single frame subscriber. Everything the app does per frame happens here, in a
   * fixed order, so behaviour is reproducible and easy to reason about.
   */
  private readonly frameSubscriber: FrameSubscriber = {
    order: 0,

    fixedUpdate: (dt: number): void => {
      if (this.entered) this.local.fixedUpdate(dt);
    },

    update: (dt: number): void => {
      this.elapsed += dt;
      this.input.pollGamepad();

      // Camera follows the character's chest height rather than its feet, so the world
      // is framed at eye level.
      this.tmpVec.copy(this.local.position);
      this.camera.update(dt, this.tmpVec);

      this.local.update(dt);
      this.local.character.updateLod(this.renderer.camera.position);
      this.remote.update(dt, this.renderer.camera.position);

      const serverTime = this.connection?.serverNow() ?? Date.now();
      this.island.update(this.elapsed, serverTime, this.local.position);
      this.renderer.setBloomStrength(this.island.sky.bloomStrength());

      this.updateNameTags();
      this.updateZone(dt);
      this.updateInteractables(dt);

      this.sync?.tickOutbound(dt);
      this.publishStats();
    },
  };

  /** Feed the name-tag layer with everyone it might want to label. */
  private updateNameTags(): void {
    const targets = [];
    for (const view of this.remote.views()) {
      const position = this.remote.positionOf(view.id);
      if (!position) continue;
      targets.push({
        id: view.id,
        name: view.name,
        position,
        // The host of whatever is running gets the accent, so you can find them.
        highlight: view.role >= Role.Host,
      });
    }
    this.nameTags.update(targets, this.renderer.camera);
  }

  /**
   * Detect zone changes and react: title card, ambience crossfade, camera framing.
   *
   * Checked every frame because it is two arithmetic operations, and because a zone
   * boundary you cross while running should register immediately.
   */
  private updateZone(_dt: number): void {
    const zoneId = zoneAt(this.local.position.x, this.local.position.z);
    if (zoneId === this.lastZone) return;
    this.lastZone = zoneId;

    const zone = getZone(zoneId);
    if (!zone) return;

    self.update((s) => ({ ...s, zone: zoneId }));
    currentZone.set({ id: zone.id, name: zone.name, nameJa: zone.nameJa, caption: zone.caption });

    // The title card is shown only once you are actually in the world — flashing zone
    // names over the entry screen would be noise.
    if (this.entered) {
      zoneAnnounce.set(true);
      if (this.zoneCardTimer !== null) clearTimeout(this.zoneCardTimer);
      this.zoneCardTimer = setTimeout(() => zoneAnnounce.set(false), ZONE_CARD_MS);
    }

    this.ambience.setZoneKind(zone.ambience);

    // Framing follows the kind of place you are in: scenic places open out, rest places
    // draw in, everything else is the default.
    this.camera.setFraming(zone.kind === 'scenic' ? 'wide' : zone.kind === 'rest' ? 'close' : 'default');
  }

  /**
   * Find the interactable within reach, if any, and publish it as the contextual prompt.
   *
   * Throttled: there are nine interactables on the island and the answer cannot change
   * meaningfully within an eighth of a second.
   */
  private updateInteractables(dt: number): void {
    if (!this.entered) return;

    this.interactAccumulator += dt;
    if (this.interactAccumulator >= 1 / INTERACT_CHECK_HZ) {
      this.interactAccumulator = 0;

      let found: { id: string; label: string; kind: 'use' | 'sit' } | null = null;
      let bestDistance = Infinity;

      for (const item of INTERACTABLES) {
        const p = interactablePosition(item);
        const d = Math.hypot(this.local.position.x - p.x, this.local.position.z - p.z);
        if (d <= item.range && d < bestDistance) {
          bestDistance = d;
          found = { id: item.id, label: item.label, kind: item.kind };
        }
      }

      if (found?.id !== this.nearbyInteractable?.id) {
        this.nearbyInteractable = found;
        interactPrompt.set(found ? { id: found.id, label: found.label } : null);
      }
    }

    if (this.input.consumeInteract()) this.performInteract();
  }

  /** Act on the nearby interactable. */
  private performInteract(): void {
    const target = this.nearbyInteractable;
    if (!target) return;

    if (target.kind === 'sit') {
      // Sitting is a toggle, and it is purely local until the server echoes it back to
      // everyone else — you should never wait a round trip to sit down.
      const seated = !getSelfSnapshot().seated;
      this.local.setSeated(seated);
      self.update((s) => ({ ...s, seated }));
      this.sync?.interact(target.id, seated ? 'sit' : 'stand');
      return;
    }

    this.sync?.interact(target.id, 'use');
    notify(target.label === 'Read' ? 'Nothing new on the board' : '…', 'neutral', 2200);
  }

  private publishStats(): void {
    const info = this.renderer.renderer.info;
    stats.update((s) => ({
      ...s,
      fps: this.renderer.fps,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      pixelRatio: Math.round(this.renderer.pixelRatio * 100) / 100,
    }));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Publish the real command implementations for the interface to call.
   *
   * Every one of these is a *request*: it tells the server what the player wants and
   * lets the server decide. The only exceptions are the purely local ones (quality,
   * mute), which have no shared consequences.
   */
  private registerCommands(): void {
    const impl: WorldCommands = {
      enterWorld: (name, appearance) => this.enterWorld(name, appearance),

      joinActivity: (id, mode) => {
        this.sync?.joinActivity(id, mode);
        // Walk toward a sensible spot rather than teleporting. The server will confirm
        // the attachment; the walk starts immediately because it is only movement.
        const activity = getActivitySnapshot(id);
        if (activity) {
          const zone = getZone(activity.zone);
          const index = mode === 'participant' ? activity.participantCount : activity.audienceCount + 8;
          const slot = crowdSlot(activity.zone, index);
          const target = slot ?? (zone ? { x: zone.x, z: zone.z } : null);
          if (target) void this.local.walkTo(target.x, target.z);
        }
      },

      leaveActivity: () => {
        const current = getSelfSnapshot().activity;
        if (current) this.sync?.leaveActivity(current);
      },

      checkIn: () => {
        const current = getSelfSnapshot().activity;
        if (current) this.sync?.checkIn(current);
        else notify('Join something first', 'neutral');
      },

      emote: (emote) => this.sync?.sendEmote(emote as Emote),

      interact: () => this.performInteract(),

      switchRoom: (id) => this.sync?.switchRoom(id),

      setQuality: (tier: QualityTier) => {
        settings.update((s) => ({ ...s, quality: tier }));
        // A tier change alters scene *content* (mesh density, scatter counts), which
        // cannot be rebuilt in place without a visible hitch, so it takes effect on the
        // next load. Saying so is better than pretending it applied.
        notify('Quality applies next time you load', 'neutral', 4000);
      },

      setMuted: (muted) => {
        settings.update((s) => ({ ...s, muted }));
        void this.ambience.unlock().then(() => this.ambience.setMuted(muted));
      },

      travelTo: (zoneId) => {
        const zone = getZone(zoneId);
        if (!zone) return;
        // "Travel" walks you there. There is no fast travel on Nagisa — the island is
        // small enough to cross in ninety seconds, and the crossing is the product.
        void this.local.walkTo(zone.x, zone.z);
        notify(`Walking to ${zone.name}`, 'neutral');
      },

      setActivityState: (id: ActivityId, state: ActivityState) => {
        this.sync?.send({ t: 'host_activity_state', activity: id, state });
      },

      announce: (text: string, scope: AnnouncementView['scope']) => {
        this.sync?.send({ t: 'host_announce', text: text.slice(0, PROTOCOL.MAX_ANNOUNCEMENT_LENGTH), scope });
      },
    };

    commands.set(impl);
  }

  /** React to settings the engine owns. */
  private subscribeSettings(): void {
    settings.subscribe((s) => {
      this.nameTags.enabled = s.showNames;
      this.ambience.setMuted(s.muted);
    });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.zoneCardTimer !== null) clearTimeout(this.zoneCardTimer);
    this.sync?.dispose();
    this.connection?.dispose();
    void this.ambience.dispose();
    this.nameTags.dispose();
    this.remote.dispose();
    this.island.dispose();
    this.input.dispose();
    this.renderer.dispose();
  }

  /** Exposed for the debug console and for tests. */
  get debug(): Record<string, unknown> {
    return {
      renderer: this.renderer,
      island: this.island,
      local: this.local,
      remote: this.remote,
      connection: this.connection,
      spawn: spawnPoint,
      stage: stagePosition,
      templates: ACTIVITY_TEMPLATES,
    };
  }
}

// ---------------------------------------------------------------------------
// Store snapshot helpers
// ---------------------------------------------------------------------------
//
// Svelte stores are push-based; these read the current value synchronously for the few
// places in the engine that need it inside an event handler. Subscribing and immediately
// unsubscribing is the documented way to do this and costs nothing.

function snapshot<T>(store: { subscribe: (run: (value: T) => void) => () => void }): T {
  let value!: T;
  store.subscribe((v) => {
    value = v;
  })();
  return value;
}

function getSelfSnapshot(): SelfState {
  return snapshot(self);
}

function getSettingsSnapshot(): { muted: boolean } {
  return snapshot(settings);
}

function getActivitySnapshot(id: ActivityId) {
  return snapshot(activities).find((a) => a.id === id) ?? null;
}
