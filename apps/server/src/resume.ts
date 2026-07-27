/**
 * Resume tokens.
 * ==============
 *
 * A resume token lets a client that briefly drops connection (an elevator, a screen
 * lock, a flaky mobile radio) come back as the *same* player — same id, same role, same
 * activity attachment — rather than walking back in as a stranger. It is deliberately
 * opaque and signed rather than a raw player id: a raw id would let anyone who sniffs
 * one WebSocket URL hijack a stranger's session by presenting their id in `hello`.
 *
 * ## Design
 *
 * The token is `base64url(payload-json) + '.' + base64url(HMAC-SHA256(payload, secret))`.
 * HMAC (not encryption) is the right primitive here: the payload (a player id, a room
 * id, an issue time) is not secret, it just must not be *forgeable* — a client must not
 * be able to mint a token claiming to be a different player. `timingSafeEqual` guards
 * the comparison so verification time doesn't leak how many signature bytes matched.
 *
 * ## What a valid token does *not* guarantee
 *
 * A cryptographically valid token only proves "this payload was issued by us." It does
 * **not** by itself prove the resume should be honoured — that also requires the named
 * player to still be sitting in the room's grace-window state (see `room.ts`,
 * `PROTOCOL.SESSION_GRACE_MS`). A token for a player who disconnected an hour ago is
 * still a valid signature; `room.ts` is what actually enforces the grace window by no
 * longer having that player to hand back. This file only answers "was this tampered
 * with," never "should this be honoured right now" — that second question needs live
 * room state a pure crypto function cannot have.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PlayerId, RoomId } from '@nagisa/shared';

/** The information bound into a resume token. */
export interface ResumePayload {
  playerId: PlayerId;
  room: RoomId;
  /** Epoch ms the token was issued. Used only as a coarse sanity bound — see {@link verifyResumeToken}. */
  issuedAt: number;
}

/**
 * A generous outer bound on token age, independent of the room's own (much shorter)
 * grace window. This exists purely so a token cannot be replayed indefinitely if it
 * somehow leaked (e.g. logged) years after issuance; it is not the mechanism that
 * enforces normal reconnect-grace semantics.
 */
const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

function sign(secret: string, b64Payload: string): string {
  return createHmac('sha256', secret).update(b64Payload).digest('base64url');
}

/** Issue a fresh, signed resume token for `payload`. Called once per `hello` (see ServerWelcome docs: "rotates on each welcome"). */
export function issueResumeToken(secret: string, payload: Omit<ResumePayload, 'issuedAt'>): string {
  const full: ResumePayload = { ...payload, issuedAt: Date.now() };
  const b64Payload = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const sig = sign(secret, b64Payload);
  return `${b64Payload}.${sig}`;
}

/**
 * Verify a token's signature and basic shape. Returns the payload if valid and not
 * absurdly old, or `null` for anything else — malformed, tampered, or expired tokens
 * are all treated identically (per `ClientHello.resumeToken` docs: "invalid or expired
 * tokens are ignored rather than rejected — the client silently becomes a new visitor").
 * Never throws.
 */
export function verifyResumeToken(secret: string, token: string): ResumePayload | null {
  try {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const b64Payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = sign(secret, b64Payload);

    const sigBuf = Buffer.from(sig, 'base64url');
    const expectedBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

    const payload = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8')) as Partial<ResumePayload>;
    if (typeof payload.playerId !== 'string' || typeof payload.room !== 'string' || typeof payload.issuedAt !== 'number') {
      return null;
    }
    if (Date.now() - payload.issuedAt > MAX_TOKEN_AGE_MS) return null;
    return payload as ResumePayload;
  } catch {
    return null;
  }
}
