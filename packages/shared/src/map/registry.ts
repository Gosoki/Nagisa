/**
 * The map registry.
 * =================
 *
 * Holds every known {@link MapPack}, tracks which one is live, and tells the engine when
 * that changes. Deliberately tiny: it is a variable, a Map, and a list of callbacks.
 *
 * ### Why a registry rather than an import
 *
 * `terrain.ts` used to hold the island's data inline, which meant the island *was* the
 * engine. Anything that wanted a second map had to fork the file. Going through a registry
 * costs one indirection on data that is read at module scope and cached, and buys the
 * ability to hand the engine somewhere else to be.
 *
 * ### Switching is not free, and is not async
 *
 * {@link setActiveMap} is synchronous and immediate: the moment it returns, `heightAt` is
 * answering about the new world. Every derived structure keyed to the old one — path
 * profiles, the segment index, zone lookup tables, the meshed terrain in the client's
 * worker — is stale, so subscribers are called *before* the function returns and are
 * expected to drop their caches then and there.
 *
 * Callers with live players must therefore treat a switch as a teleport: positions in the
 * old map's coordinates are meaningless in the new one, and everyone needs re-spawning.
 * The server does this in `room.ts`; nothing else should call `setActiveMap` while a room
 * is populated.
 */

import type { MapPack } from './types.js';

const packs = new Map<string, MapPack>();
const listeners = new Set<(pack: MapPack) => void>();

let active: MapPack | null = null;

/**
 * Add a pack. Registering an id that already exists replaces it — which is how a host
 * application ships its own maps without patching this package.
 */
export function registerMap(pack: MapPack): void {
  packs.set(pack.id, pack);
  // Re-registering the live map (hot reload, or an edited pack) must not leave the engine
  // holding the previous object.
  if (active?.id === pack.id) setActiveMap(pack.id);
}

/** Every registered pack, in registration order. */
export function listMaps(): readonly MapPack[] {
  return [...packs.values()];
}

export function getMap(id: string): MapPack | undefined {
  return packs.get(id);
}

/**
 * The live pack.
 *
 * Throws rather than returning null if nothing has been activated: every function in the
 * engine calls this, and a null check at each of them would be noise around a condition
 * that only ever means "the shared package was imported wrong".
 */
export function activeMap(): MapPack {
  if (!active) throw new Error('no active map — import @nagisa/shared/maps or call setActiveMap() first');
  return active;
}

/** Id of the live pack, or null before one is set. Safe to call at any time. */
export function activeMapId(): string | null {
  return active?.id ?? null;
}

/**
 * Make `id` live and notify every subscriber synchronously.
 *
 * Returns the pack. Throws if `id` is unknown — silently falling back to the previous map
 * would put the server and the client on different worlds, which is the one failure mode
 * this whole mechanism exists to prevent.
 */
export function setActiveMap(id: string): MapPack {
  const pack = packs.get(id);
  if (!pack) {
    throw new Error(`unknown map "${id}" — registered: ${[...packs.keys()].join(', ') || '(none)'}`);
  }
  active = pack;
  for (const listener of listeners) listener(pack);
  return pack;
}

/**
 * Subscribe to map changes.
 *
 * The callback fires immediately with the current pack if one is already active, so a
 * subscriber never has to handle "before the first map" as a separate case. Returns an
 * unsubscribe function.
 */
export function onMapChange(listener: (pack: MapPack) => void): () => void {
  listeners.add(listener);
  if (active) listener(active);
  return () => listeners.delete(listener);
}
