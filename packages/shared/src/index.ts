/**
 * `@nagisa/shared` — the contract between the client and the server.
 *
 * Nothing in this package imports from `three`, `svelte`, `ws` or `node:*`. It is pure
 * TypeScript and runs unchanged in a browser, in Node, and in a Web Worker. That
 * constraint is what lets the server validate movement against exactly the terrain the
 * player is standing on, and what lets the client and server share one definition of
 * every zone, role and message.
 *
 * Four modules:
 *
 * - `protocol` — every WebSocket message, plus the packing helpers for the hot path.
 * - `terrain`  — the island's surface as a pure analytic function of (x, z).
 * - `world`    — what the terrain *means*: zones, venues, spawn points, landmarks.
 * - `tokens`   — the shared palette, type scale and motion curves.
 */

export * from './map/types.js';
export * from './map/registry.js';
export * from './maps/index.js';
export * from './protocol.js';
export * from './terrain.js';
export * from './movement.js';
export * from './world.js';
export * from './tokens.js';
