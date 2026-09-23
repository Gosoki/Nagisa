/**
 * Badges.
 * =======
 *
 * Small marks of having done something on the island. A badge, once earned, is kept for as
 * long as the visitor's key is; the one you choose to wear is shown under your name.
 *
 * Earning rules live on the server (`apps/server/src/games/profiles.ts`); this file is the
 * list and the words.
 */

export const BADGE_IDS = [
  'walker',
  'angler',
  'master-angler',
  'quiz-champ',
  'derby-champ',
  'lucky',
  'janken',
  'treasure',
  'regular',
  'daruma',
] as const;

export type BadgeId = (typeof BADGE_IDS)[number];

export interface BadgeInfo {
  readonly id: BadgeId;
  readonly icon: string;
  readonly zh: string;
  readonly ja: string;
  readonly en: string;
  /** How it is earned, for the collection book. */
  readonly howZh: string;
  readonly howJa: string;
  readonly howEn: string;
}

/** How many catches make an angler. */
export const ANGLER_CATCHES = 10;
/** How many janken wins make a master. */
export const JANKEN_MASTER_WINS = 10;
/** How many finds make a treasure hunter. Mirrors `TREASURE_HUNTER_FINDS` in `treasure.ts`. */
const TREASURE_FINDS = 3;
/** How many days of tasks make a regular. Mirrors `REGULAR_DAYS` in `daily.ts`. */
const DAILY_DAYS = 7;

export const BADGES: readonly BadgeInfo[] = [
  { id: 'walker', icon: '🗺️', zh: '环岛旅人', ja: '島めぐり', en: 'Island Walker', howZh: '集齐全岛印章', howJa: 'スタンプを全部集める', howEn: 'Collect every stamp on the island' },
  { id: 'angler', icon: '🎣', zh: '钓鱼人', ja: '釣り人', en: 'Angler', howZh: `钓到 ${ANGLER_CATCHES} 条鱼`, howJa: `魚を${ANGLER_CATCHES}匹釣る`, howEn: `Catch ${ANGLER_CATCHES} fish` },
  { id: 'master-angler', icon: '🐟', zh: '钓鱼名人', ja: '釣り名人', en: 'Master Angler', howZh: '集齐所有鱼类图鉴', howJa: '魚図鑑をコンプリート', howEn: 'Complete the fish book' },
  { id: 'quiz-champ', icon: '👑', zh: '问答王', ja: 'クイズ王', en: 'Quiz Champion', howZh: '在○×问答中胜出', howJa: '○×クイズで優勝する', howEn: 'Win a ○× quiz' },
  { id: 'derby-champ', icon: '🏆', zh: '钓鱼大赛冠军', ja: '釣り大会優勝', en: 'Derby Champion', howZh: '在钓鱼大赛中夺冠', howJa: '釣り大会で優勝する', howEn: 'Win the fishing derby' },
  { id: 'lucky', icon: '🌸', zh: '大吉', ja: '大吉', en: 'Lucky Star', howZh: '抽到大吉', howJa: '大吉を引く', howEn: 'Draw 大吉 at the shrine' },
  { id: 'janken', icon: '✌️', zh: '猜拳高手', ja: 'じゃんけん名人', en: 'Janken Master', howZh: `猜拳赢 ${JANKEN_MASTER_WINS} 次`, howJa: `じゃんけんで${JANKEN_MASTER_WINS}回勝つ`, howEn: `Win ${JANKEN_MASTER_WINS} rounds of janken` },
  { id: 'treasure', icon: '💎', zh: '寻宝达人', ja: '宝探し名人', en: 'Treasure Hunter', howZh: `在寻宝中挖到 ${TREASURE_FINDS} 件宝物`, howJa: `宝探しで宝を${TREASURE_FINDS}つ掘り当てる`, howEn: `Dig up ${TREASURE_FINDS} treasures in the treasure hunt` },
  { id: 'regular', icon: '🏮', zh: '岛上常客', ja: '島の常連', en: 'Regular', howZh: `完成 ${DAILY_DAYS} 天的每日任务`, howJa: `今日のおつとめを${DAILY_DAYS}日分こなす`, howEn: `Finish the day's tasks on ${DAILY_DAYS} days` },
  { id: 'daruma', icon: '🏁', zh: '木头人冠军', ja: 'だるまさん名人', en: 'Daruma Champion', howZh: '在一二三木头人中第一个冲过终点', howJa: 'だるまさんがころんだで一番乗りする', howEn: 'Be first over the line in Daruma-san ga Koronda' },
];

const BADGE_INDEX = new Map(BADGES.map((b) => [b.id, b]));

export function getBadge(id: string): BadgeInfo | undefined {
  return BADGE_INDEX.get(id as BadgeId);
}

export function isBadgeId(v: unknown): v is BadgeId {
  return typeof v === 'string' && BADGE_INDEX.has(v as BadgeId);
}
