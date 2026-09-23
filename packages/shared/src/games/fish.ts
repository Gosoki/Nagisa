/**
 * Fish.
 * =====
 *
 * What lives in the water around the island, how often it bites, and how big it grows.
 *
 * The **server** rolls every catch from this table — the client never decides what it
 * caught, only reports that it struck in time — so the table is the whole of the game's
 * economy and a single place to tune it. The **client** reads the same table for names and
 * sizes when it draws the catch card and the collection book.
 *
 * Species are real fish of Japanese coastal waters. The one exception is at the end of the
 * list, and every angler has caught one.
 */

/** Where a spot is. Harbour water is deep and sheltered; the beach is surf over sand. */
export type FishHabitat = 'harbor' | 'beach';

export type FishRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'junk';

export interface FishSpecies {
  /** Stable id. Persisted in visitor collections — never rename. */
  readonly id: string;
  readonly zh: string;
  readonly ja: string;
  readonly en: string;
  readonly rarity: FishRarity;
  /** Size range, centimetres. The roll is skewed toward the low end; trophies are rare. */
  readonly minCm: number;
  readonly maxCm: number;
  /** Where it bites. Omitted = anywhere. */
  readonly habitat?: FishHabitat;
  /** When it bites. Omitted = any hour. `night` species bite only in the dark hours. */
  readonly time?: 'day' | 'night';
  /** Tint for the catch card and the leaping fish, as 0xRRGGBB. */
  readonly color: number;
}

/** Relative weight of each rarity when rolling a catch. */
export const RARITY_WEIGHT: Readonly<Record<FishRarity, number>> = {
  common: 30,
  uncommon: 12,
  rare: 4,
  epic: 1.2,
  legendary: 0.3,
  junk: 3,
};

export const FISH: readonly FishSpecies[] = [
  { id: 'aji', zh: '竹荚鱼', ja: 'アジ', en: 'Horse mackerel', rarity: 'common', minCm: 12, maxCm: 35, color: 0x9fb5c0 },
  { id: 'iwashi', zh: '沙丁鱼', ja: 'イワシ', en: 'Sardine', rarity: 'common', minCm: 10, maxCm: 22, color: 0xa9bccb },
  { id: 'saba', zh: '鲭鱼', ja: 'サバ', en: 'Chub mackerel', rarity: 'common', minCm: 22, maxCm: 45, habitat: 'harbor', color: 0x6f9a8e },
  { id: 'kisu', zh: '沙梭', ja: 'キス', en: 'Japanese whiting', rarity: 'common', minCm: 12, maxCm: 28, habitat: 'beach', color: 0xd9d0b8 },
  { id: 'haze', zh: '虾虎鱼', ja: 'ハゼ', en: 'Goby', rarity: 'common', minCm: 6, maxCm: 18, habitat: 'harbor', color: 0xb49a78 },
  { id: 'karei', zh: '鲽鱼', ja: 'カレイ', en: 'Flounder', rarity: 'uncommon', minCm: 18, maxCm: 45, habitat: 'beach', color: 0xa38a6a },
  { id: 'kasago', zh: '石狗公', ja: 'カサゴ', en: 'Scorpionfish', rarity: 'uncommon', minCm: 12, maxCm: 30, habitat: 'harbor', color: 0xc0674a },
  { id: 'mebaru', zh: '平鲉', ja: 'メバル', en: 'Rockfish', rarity: 'uncommon', minCm: 12, maxCm: 30, time: 'night', color: 0x8a7a6a },
  { id: 'ika', zh: '鱿鱼', ja: 'イカ', en: 'Squid', rarity: 'uncommon', minCm: 15, maxCm: 40, time: 'night', color: 0xe8d8d0 },
  { id: 'tako', zh: '章鱼', ja: 'タコ', en: 'Octopus', rarity: 'uncommon', minCm: 20, maxCm: 60, habitat: 'harbor', color: 0xb85a4a },
  { id: 'fugu', zh: '河豚', ja: 'フグ', en: 'Pufferfish', rarity: 'uncommon', minCm: 10, maxCm: 35, color: 0xd6c48a },
  { id: 'suzuki', zh: '鲈鱼', ja: 'スズキ', en: 'Japanese sea bass', rarity: 'rare', minCm: 30, maxCm: 90, color: 0xa8b2b5 },
  { id: 'kurodai', zh: '黑鲷', ja: 'クロダイ', en: 'Black sea bream', rarity: 'rare', minCm: 25, maxCm: 55, habitat: 'harbor', color: 0x5f6468 },
  { id: 'hirame', zh: '牙鲆', ja: 'ヒラメ', en: 'Olive flounder', rarity: 'rare', minCm: 35, maxCm: 90, habitat: 'beach', color: 0x8f7a5a },
  { id: 'madai', zh: '真鲷', ja: 'マダイ', en: 'Red sea bream', rarity: 'epic', minCm: 30, maxCm: 80, time: 'day', color: 0xe07a78 },
  { id: 'buri', zh: '鰤鱼', ja: 'ブリ', en: 'Yellowtail', rarity: 'epic', minCm: 50, maxCm: 100, color: 0x7fa0b8 },
  { id: 'tatsu', zh: '海马', ja: 'タツノオトシゴ', en: 'Seahorse', rarity: 'epic', minCm: 5, maxCm: 12, habitat: 'harbor', color: 0xe0b060 },
  { id: 'maguro', zh: '金枪鱼', ja: 'マグロ', en: 'Bluefin tuna', rarity: 'legendary', minCm: 100, maxCm: 250, color: 0x3f5f7f },
  { id: 'boot', zh: '旧靴子', ja: '長ぐつ', en: 'Old boot', rarity: 'junk', minCm: 24, maxCm: 30, color: 0x5a4a3a },
];

const FISH_INDEX = new Map(FISH.map((f) => [f.id, f]));

export function getFish(id: string): FishSpecies | undefined {
  return FISH_INDEX.get(id);
}

/** Every species a collection can be completed with — everything but the junk. */
export const COLLECTIBLE_FISH: readonly FishSpecies[] = FISH.filter((f) => f.rarity !== 'junk');

/** Species that can bite at this habitat and hour. */
export function fishFor(habitat: FishHabitat, night: boolean): FishSpecies[] {
  return FISH.filter(
    (f) => (!f.habitat || f.habitat === habitat) && (!f.time || (f.time === 'night') === night),
  );
}

/**
 * Roll one catch. `rand` is injected so the server can test the distribution
 * deterministically; pass `Math.random` in production.
 *
 * Size is skewed low (the square of a uniform), so a trophy is an event rather than the
 * common case, and a size record is worth announcing.
 */
export function rollCatch(habitat: FishHabitat, night: boolean, rand: () => number): { fish: FishSpecies; sizeCm: number } {
  const pool = fishFor(habitat, night);
  let total = 0;
  for (const f of pool) total += RARITY_WEIGHT[f.rarity];
  let pick = rand() * total;
  let fish = pool[pool.length - 1];
  for (const f of pool) {
    pick -= RARITY_WEIGHT[f.rarity];
    if (pick <= 0) {
      fish = f;
      break;
    }
  }
  const u = rand();
  const sizeCm = Math.round((fish.minCm + (fish.maxCm - fish.minCm) * u * u) * 10) / 10;
  return { fish, sizeCm };
}
