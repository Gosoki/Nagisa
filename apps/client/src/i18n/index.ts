/**
 * Language.
 * =========
 *
 * The interface speaks Chinese, Japanese and English. Which one is a setting (see
 * `Settings.lang` in state/settings.ts), defaulting to the browser's own language.
 *
 * Two kinds of text come through here:
 *
 * - **Interface strings**, keyed (`t('hud.people')`), from the dictionaries in this folder.
 *   `core.ts` holds the interface's own furniture; `games.ts` holds everything the games
 *   say. A key missing from one language falls back to English, then to the key itself, so
 *   a gap shows up as a readable English word rather than a blank.
 * - **World data** — zone names, activity titles, fish, badges, quiz statements — which is
 *   authored in the shared package with its translations beside it. The helpers at the end
 *   pick the right field; nothing here duplicates the island's own words.
 *
 * Components read `$t` (a store of the translate function), so a language change re-renders
 * everything at once without a reload.
 */

import { derived, get, type Readable } from 'svelte/store';
import {
  FISH,
  FORTUNES,
  LUCKY_DIRECTIONS,
  LUCKY_ITEMS,
  getBadge,
  getFish,
  getQuizQuestion,
  getTemplate,
  getZone,
  type ActivityView,
  type InteractableEffect,
  type RoomView,
  type ZoneId,
} from '@nagisa/shared';
import { settings, type Lang } from '../state/settings.js';
import { CORE } from './core.js';
import { GAMES } from './games.js';

export type { Lang };
export const LANGS: readonly Lang[] = ['zh', 'ja', 'en'];

/** Each language's own name for itself, for the picker. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { zh: '中文', ja: '日本語', en: 'English' };

/** One dictionary: flat keys to strings. `{name}` placeholders are filled from params. */
export type Dict = Readonly<Record<string, string>>;
export type Dictionaries = Readonly<Record<Lang, Dict>>;

const DICTS: Record<Lang, Record<string, string>> = {
  zh: { ...CORE.zh, ...GAMES.zh },
  ja: { ...CORE.ja, ...GAMES.ja },
  en: { ...CORE.en, ...GAMES.en },
};

export type Params = Readonly<Record<string, string | number>>;

/** Translate `key` in `lang`, filling `{placeholders}` from `params`. Never throws. */
export function translate(lang: Lang, key: string, params?: Params): string {
  const raw = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The current language, as a store. */
export const lang: Readable<Lang> = derived(settings, ($s) => $s.lang);

/** The translate function for the current language. Use as `$t('key', { n: 3 })`. */
export const t: Readable<(key: string, params?: Params) => string> = derived(lang, ($lang) => {
  return (key: string, params?: Params) => translate($lang, key, params);
});

/** Translate outside a component (engine code, notices). */
export function tr(key: string, params?: Params): string {
  return translate(get(lang), key, params);
}

/** Current language, read once. */
export function currentLang(): Lang {
  return get(lang);
}

// ---------------------------------------------------------------------------
// World data
// ---------------------------------------------------------------------------

/** A zone's name in `lang`. Chinese falls back to the Japanese name, which shares its script. */
export function zoneName(id: ZoneId | null | undefined, l: Lang = currentLang()): string {
  if (!id) return '';
  const zone = getZone(id);
  if (!zone) return String(id);
  if (l === 'zh') return zone.nameZh ?? zone.nameJa;
  if (l === 'ja') return zone.nameJa;
  return zone.name;
}

/** A zone's arrival caption in `lang`. */
export function zoneCaption(id: ZoneId | null | undefined, l: Lang = currentLang()): string {
  const zone = id ? getZone(id) : undefined;
  if (!zone) return '';
  if (l === 'zh') return zone.captionZh ?? zone.caption;
  if (l === 'ja') return zone.captionJa ?? zone.caption;
  return zone.caption;
}

/**
 * An activity's title. Localised from its template when the server's title is still the
 * template's own; a host-renamed activity keeps the name its host gave it.
 */
export function activityTitle(a: Pick<ActivityView, 'title' | 'templateId'>, l: Lang = currentLang()): string {
  const tpl = getTemplate(a.templateId);
  if (!tpl || tpl.title !== a.title) return a.title;
  if (l === 'zh') return tpl.titleZh ?? tpl.title;
  if (l === 'ja') return tpl.titleJa ?? tpl.title;
  return tpl.title;
}

export function activityBlurb(a: Pick<ActivityView, 'blurb' | 'templateId'>, l: Lang = currentLang()): string {
  const tpl = getTemplate(a.templateId);
  if (!tpl || tpl.blurb !== a.blurb) return a.blurb;
  if (l === 'zh') return tpl.blurbZh ?? tpl.blurb;
  if (l === 'ja') return tpl.blurbJa ?? tpl.blurb;
  return tpl.blurb;
}

/** A template's title by id (for the host's scheduling picker). */
export function templateTitle(id: string, l: Lang = currentLang()): string {
  const tpl = getTemplate(id);
  if (!tpl) return id;
  if (l === 'zh') return tpl.titleZh ?? tpl.title;
  if (l === 'ja') return tpl.titleJa ?? tpl.title;
  return tpl.title;
}

/**
 * A public shard's name in the player's language. The server names shards in English
 * ("Nagisa — Shore 2") for logs and metrics; the number is all that differs between them.
 */
export function roomName(room: Pick<RoomView, 'id' | 'name' | 'kind' | 'title'>, l: Lang = currentLang()): string {
  const shore = room.kind === 'public' ? /^shore-(\d+)$/.exec(room.id) : null;
  return shore ? translate(l, 'island.shore', { n: Number(shore[1]) }) : room.title || room.name;
}

/** How an island reads in a sentence: a shard's name, or a private island's own name or its code. */
export function islandName(room: Pick<RoomView, 'id' | 'name' | 'kind' | 'code' | 'title'>, l: Lang = currentLang()): string {
  if (room.kind !== 'private') return roomName(room, l);
  return room.title || translate(l, 'island.private', { code: room.code ?? '' });
}

export function fishName(id: string, l: Lang = currentLang()): string {
  const fish = getFish(id);
  return fish ? fish[l] : id;
}

export function badgeName(id: string, l: Lang = currentLang()): string {
  const badge = getBadge(id);
  return badge ? badge[l] : id;
}

export function badgeHow(id: string, l: Lang = currentLang()): string {
  const badge = getBadge(id);
  if (!badge) return '';
  return l === 'zh' ? badge.howZh : l === 'ja' ? badge.howJa : badge.howEn;
}

export function badgeIcon(id: string): string {
  return getBadge(id)?.icon ?? '';
}

/** A quiz statement and its explanation in `lang`. */
export function quizText(id: string | null | undefined, l: Lang = currentLang()): { text: string; explain: string } {
  const q = id ? getQuizQuestion(id) : undefined;
  if (!q) return { text: '', explain: '' };
  return { text: q[l], explain: q.explain[l] };
}

/** An omikuji slip's words. */
export function fortuneText(
  fortune: number,
  item: number,
  direction: number,
  l: Lang = currentLang(),
): { kanji: string; name: string; line: string; item: string; direction: string } {
  const f = FORTUNES[fortune] ?? FORTUNES[FORTUNES.length - 1];
  const it = LUCKY_ITEMS[item] ?? LUCKY_ITEMS[0];
  const dir = LUCKY_DIRECTIONS[direction] ?? LUCKY_DIRECTIONS[0];
  return {
    kanji: f.kanji,
    name: l === 'en' ? f.en : f.kanji,
    line: l === 'zh' ? f.zh : l === 'ja' ? f.ja : f.enLine,
    item: it[l],
    direction: dir[l],
  };
}

/** The verb on an interaction prompt. */
export function interactLabel(effect: InteractableEffect, kind: 'use' | 'sit', l: Lang = currentLang()): string {
  if (kind === 'sit') return translate(l, 'prompt.sit');
  return translate(l, `prompt.${effect}`);
}

/** Every fish, for the collection book, in table order. */
export const ALL_FISH = FISH;
