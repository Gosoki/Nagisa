/**
 * Built-in map packs, and the default.
 * ====================================
 *
 * Importing this module registers every map that ships with Nagisa and activates one, so
 * that `heightAt` works the moment `@nagisa/shared` is loaded. `terrain.ts` and `world.ts`
 * import it for exactly that side effect.
 *
 * ### Choosing which map is live
 *
 * The default is {@link DEFAULT_MAP_ID}. Both hosts override it the same way, from the
 * environment they actually have:
 *
 * - **Server** — `NAGISA_MAP=lantern-atoll npm run dev -w @nagisa/server`
 * - **Client** — `?map=lantern-atoll` in the URL
 *
 * They must agree. The server sends its map id in the join acknowledgement and the client
 * refuses to enter a world it did not load; a mismatch is a hard error rather than a
 * player standing in mid-air over someone else's island.
 *
 * ### Adding your own
 *
 * Write a `MapPack` anywhere, call `registerMap(pack)` before connecting, and pass its id.
 * Nothing here needs editing — this file is the shipped set, not the allowed set.
 */

import { registerMap, setActiveMap, activeMapId } from '../map/registry.js';
import { LANTERN_ATOLL } from './lantern-atoll.js';
import { NAGISA_ISLAND } from './nagisa-island.js';

export { NAGISA_ISLAND, LANTERN_ATOLL };

/** The map loaded when nothing asks for another. */
export const DEFAULT_MAP_ID = NAGISA_ISLAND.id;

registerMap(NAGISA_ISLAND);
registerMap(LANTERN_ATOLL);

// Only activate if nothing has already — re-importing this module must never yank the map
// out from under a host that deliberately switched.
if (activeMapId() === null) setActiveMap(DEFAULT_MAP_ID);

/**
 * Resolve a requested map id against what is registered.
 *
 * Returns the default for `null`/`undefined`/empty, which is what an absent env var or URL
 * parameter looks like. An id that is present but unknown throws: the caller asked for a
 * specific world and silently giving them a different one is how desyncs start.
 */
export function resolveMapId(requested: string | null | undefined): string {
  const id = requested?.trim();
  if (!id) return DEFAULT_MAP_ID;
  setActiveMap(id); // throws with the list of known ids if it is not one of them
  return id;
}
