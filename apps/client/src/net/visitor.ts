/**
 * The visitor key, and which island to ask for.
 * =============================================
 *
 * **The key.** A random string this browser keeps, so that the stamp card, the fish book and
 * badges outlive the tab — and so that whoever made a private island is its keeper when they
 * come back. It is not an account and not a secret worth guarding: there is nothing on the
 * island to take. The server stores only a hash of it.
 *
 * **The island.** An invite link is the page with `?island=CODE`. That is read once at
 * boot; afterwards the app keeps the address bar in step with wherever you actually are, so
 * a reload returns you there and a copied URL is an invitation.
 */

import { VISITOR_KEY_PATTERN, normaliseRoomCode } from '@nagisa/shared';

const VISITOR_KEY = 'nagisa.visitor';

/** This browser's visitor key, minted on first use. `undefined` when storage is unavailable. */
export function visitorKey(): string | undefined {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing && VISITOR_KEY_PATTERN.test(existing)) return existing;
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    // base64url, 24 characters, no padding.
    const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem(VISITOR_KEY, key);
    return key;
  } catch {
    // Private browsing with storage blocked: a visitor with no past. Everything still works.
    return undefined;
  }
}

/** The invite code in the page's address, if there is one. */
export function inviteCodeFromUrl(): string | null {
  try {
    return normaliseRoomCode(new URLSearchParams(location.search).get('island'));
  } catch {
    return null;
  }
}

/**
 * Point the address bar at the island you are on: `?island=CODE` on a private island,
 * nothing on a public one. Replaces the history entry rather than adding one — moving
 * between islands is not navigation the back button should replay.
 */
export function reflectIslandInUrl(code: string | null): void {
  try {
    const url = new URL(location.href);
    if (code) url.searchParams.set('island', code);
    else url.searchParams.delete('island');
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  } catch {
    /* Sandboxed iframe or similar: the address simply does not follow. */
  }
}

/**
 * A shareable link to an island.
 *
 * Built from a clean address rather than the current one: the page may be carrying
 * `?admin=` — a password — and an invitation must never pass that on. Only the map choice
 * travels, because a friend on a different map could not stand on the same ground.
 */
export function inviteLink(code: string): string {
  const here = new URL(location.href);
  const url = new URL(here.origin + here.pathname);
  const map = here.searchParams.get('map');
  if (map) url.searchParams.set('map', map);
  url.searchParams.set('island', code);
  return url.href;
}

const ADMIN_KEY = 'nagisa.admin';

/**
 * The admin token, if this tab was opened with `?admin=…`.
 *
 * Taken out of the address bar as soon as it is read — a password left in the URL ends up in
 * a screenshot, a shared link or the history — and kept for this tab's lifetime in
 * `sessionStorage`, so a reload or a reconnect still presents it.
 */
export function adminToken(): string | null {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('admin');
    if (fromUrl) {
      sessionStorage.setItem(ADMIN_KEY, fromUrl);
      url.searchParams.delete('admin');
      history.replaceState(history.state, '', url);
      return fromUrl;
    }
    return sessionStorage.getItem(ADMIN_KEY);
  } catch {
    return null;
  }
}
