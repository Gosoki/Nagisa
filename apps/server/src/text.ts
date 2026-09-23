/**
 * Cleaning what players type.
 * ===========================
 *
 * Every string a player writes — a name, a line of chat, a whisper, a guestbook signature, an
 * announcement — is shown to other people, so it goes through here first. Nothing here is
 * about markup: the interface never renders player text as HTML (Svelte escapes it, and name
 * tags are drawn with `fillText`). It is about characters that change how *other* text looks:
 *
 * - C0/C1 control characters, which have no business in a chat line;
 * - bidirectional overrides and isolates (U+202A–202E, U+2066–2069), which can make a line
 *   display backwards and a name look like somebody else's;
 * - invisible marks (zero-width space, LRM/RLM, the BOM) and line/paragraph separators, which
 *   make two different names look identical or break a line where none was typed.
 *
 * The zero-width joiner and non-joiner (U+200C/200D) are kept in text, because emoji
 * sequences and several scripts need them; names drop them too, since a name is for telling
 * people apart.
 */

/** Characters removed from any line of text. */
const UNSAFE_IN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Characters removed from names: everything above, plus the joiners. */
const UNSAFE_IN_NAME = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** A line of text: unsafe characters removed, runs of whitespace (tabs, newlines) made one space. */
export function cleanLine(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(UNSAFE_IN_TEXT, '').replace(/\s+/g, ' ').trim();
}

/** A display name: as {@link cleanLine}, stricter, and cut to `max` code points. Empty → `fallback`. */
export function cleanName(raw: unknown, max: number, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.replace(UNSAFE_IN_NAME, '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return fallback;
  return [...s].slice(0, max).join('').trim() || fallback;
}

/** Length in code points, which is what a person counts — an emoji is one, not two. */
export function textLength(s: string): number {
  return [...s].length;
}
