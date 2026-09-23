/**
 * Omikuji — the shrine's paper fortunes.
 * ======================================
 *
 * One draw a day per visitor, rolled by the server so that the day's fortune is the day's
 * fortune: drawing again returns the same slip rather than a fresh chance at 大吉. The
 * client holds the words; the wire carries three small integers.
 */

export interface Fortune {
  /** The fortune itself. Written the same in Chinese and Japanese. */
  readonly kanji: string;
  readonly reading: string;
  readonly en: string;
  /** Relative odds. */
  readonly weight: number;
  /** One line of advice for the slip. */
  readonly zh: string;
  readonly ja: string;
  readonly enLine: string;
}

/** Best to worst. Index is what travels on the wire; never reorder. */
export const FORTUNES: readonly Fortune[] = [
  { kanji: '大吉', reading: 'だいきち', en: 'Great blessing', weight: 16, zh: '万事顺遂。今天适合开始新的事情。', ja: '万事よし。新しいことを始めるのに良い日。', enLine: 'All goes well. A good day to begin something new.' },
  { kanji: '吉', reading: 'きち', en: 'Blessing', weight: 20, zh: '平稳的一天，身边的人会帮你。', ja: '穏やかな一日。周りの人が力を貸してくれる。', enLine: 'A calm day. The people around you will lend a hand.' },
  { kanji: '中吉', reading: 'ちゅうきち', en: 'Middle blessing', weight: 18, zh: '努力会有回报，别急。', ja: '努力は実る。焦らずに。', enLine: 'Effort pays off. Do not hurry it.' },
  { kanji: '小吉', reading: 'しょうきち', en: 'Small blessing', weight: 16, zh: '小小的好事就在附近。', ja: '小さな幸せがすぐそばに。', enLine: 'A small good thing is close by.' },
  { kanji: '末吉', reading: 'すえきち', en: 'Future blessing', weight: 14, zh: '好运稍后才到，耐心等待。', ja: '運は後から来る。気長に待とう。', enLine: 'Luck arrives later. Wait for it patiently.' },
  { kanji: '凶', reading: 'きょう', en: 'Curse', weight: 12, zh: '把签系在树上，把坏运留在神社吧。', ja: 'おみくじを結んで、悪い運は神社に置いていこう。', enLine: 'Tie the slip to the tree and leave the bad luck at the shrine.' },
  { kanji: '大凶', reading: 'だいきょう', en: 'Great curse', weight: 4, zh: '稀有！抽到大凶反而是一种幸运。', ja: '珍しい！大凶を引くのはある意味強運。', enLine: 'Rare! Drawing this is its own kind of luck.' },
];

/** Lucky items. Index on the wire. */
export const LUCKY_ITEMS: readonly { readonly zh: string; readonly ja: string; readonly en: string }[] = [
  { zh: '贝壳', ja: '貝がら', en: 'A seashell' },
  { zh: '热茶', ja: '温かいお茶', en: 'A hot cup of tea' },
  { zh: '纸灯笼', ja: '提灯', en: 'A paper lantern' },
  { zh: '饭团', ja: 'おにぎり', en: 'A rice ball' },
  { zh: '风铃', ja: '風鈴', en: 'A wind chime' },
  { zh: '手帕', ja: 'ハンカチ', en: 'A handkerchief' },
  { zh: '明信片', ja: '絵はがき', en: 'A postcard' },
  { zh: '猫', ja: '猫', en: 'A cat' },
  { zh: '渔网', ja: '魚あみ', en: 'A fishing net' },
  { zh: '蓝色的东西', ja: '青いもの', en: 'Something blue' },
];

/** Compass directions, clockwise from north. Index on the wire. */
export const LUCKY_DIRECTIONS: readonly { readonly zh: string; readonly ja: string; readonly en: string }[] = [
  { zh: '北', ja: '北', en: 'North' },
  { zh: '东北', ja: '北東', en: 'North-east' },
  { zh: '东', ja: '東', en: 'East' },
  { zh: '东南', ja: '南東', en: 'South-east' },
  { zh: '南', ja: '南', en: 'South' },
  { zh: '西南', ja: '南西', en: 'South-west' },
  { zh: '西', ja: '西', en: 'West' },
  { zh: '西北', ja: '北西', en: 'North-west' },
];

/** Draw a slip. `rand` is injected for tests. */
export function drawOmikuji(rand: () => number): { fortune: number; item: number; direction: number } {
  let total = 0;
  for (const f of FORTUNES) total += f.weight;
  let pick = rand() * total;
  let fortune = FORTUNES.length - 1;
  for (let i = 0; i < FORTUNES.length; i++) {
    pick -= FORTUNES[i].weight;
    if (pick <= 0) {
      fortune = i;
      break;
    }
  }
  return {
    fortune,
    item: Math.min(LUCKY_ITEMS.length - 1, Math.floor(rand() * LUCKY_ITEMS.length)),
    direction: Math.min(LUCKY_DIRECTIONS.length - 1, Math.floor(rand() * LUCKY_DIRECTIONS.length)),
  };
}
