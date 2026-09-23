/**
 * Game strings — fishing, the quiz, omikuji, stamps, janken, fireworks, the board, badges,
 * private islands, and the lines the island says when something happens.
 *
 * Same rules as `core.ts`: every key in all three languages, `en` first.
 */

import type { Dictionaries } from './index.js';

export const GAMES: Dictionaries = {
  zh: {
    // Lines in the chat log when something happens nearby.
    'event.catch': '🎣 {name} 钓到了 {size} cm 的{fish}',
    'event.catchRecord': '🎣 {name} 钓到了 {size} cm 的{fish} — 今日最大！',
    'event.omikuji': '⛩️ {name} 抽到了「{fortune}」',
    'event.stampComplete': '🗺️ {name} 集齐了全岛印章！',
    'event.dice': '🎲 {name} 掷出了 {value}（1–{sides}）',
    'event.jankenWin': '✌️ {winner} 猜拳赢了 {loser}',
    'event.jankenDraw': '✌️ {a} 和 {b} 猜拳打成平手',
    'event.badge': '{icon} {name} 获得了徽章「{badge}」',

    'whisper.to': '悄悄话 → {name}',
    'whisper.from': '{name} 对你说悄悄话',

    'hand.rock': '石头',
    'hand.paper': '布',
    'hand.scissors': '剪刀',

    'island.created': '私人小岛已创建 — 邀请码 {code}',
    'island.moved': '已来到 {name}',
    'island.public': '公共岛屿',
    'island.private': '私人小岛 {code}',

    'fish.bite': '上钩了！',
    'fish.escaped.early': '收线太早，鱼跑了',
    'fish.escaped.late': '慢了一步，鱼跑了',
    'fish.escaped.moved': '走开了，收线',
    'fish.escaped.stopped': '收线了',
    'fish.escaped.busy': '已经在钓鱼了',
    'omikuji.again': '今天已经抽过了，这是你今天的签',
    'stamp.got': '盖上了「{place}」的印章（{n}/{total}）',
    'stamp.already': '这里的印章已经盖过了',
    'firework.notHere': '花火只能在海边放（海滩或南港）',
    'quiz.eliminated': '答错了……下次加油！',
    'quiz.survived': '答对了！',
    'quiz.won': '🏆 你赢得了○×问答！',
  },

  ja: {
    'event.catch': '🎣 {name} さんが {size} cm の{fish}を釣り上げた',
    'event.catchRecord': '🎣 {name} さんが {size} cm の{fish}を釣り上げた — 本日最大！',
    'event.omikuji': '⛩️ {name} さんのおみくじは「{fortune}」',
    'event.stampComplete': '🗺️ {name} さんが島じゅうのスタンプを集めた！',
    'event.dice': '🎲 {name} さんのサイコロは {value}（1–{sides}）',
    'event.jankenWin': '✌️ {winner} さんがじゃんけんで {loser} さんに勝った',
    'event.jankenDraw': '✌️ {a} さんと {b} さんのじゃんけんは引き分け',
    'event.badge': '{icon} {name} さんがバッジ「{badge}」を手に入れた',

    'whisper.to': 'ひそひそ → {name}',
    'whisper.from': '{name} さんからひそひそ',

    'hand.rock': 'グー',
    'hand.paper': 'パー',
    'hand.scissors': 'チョキ',

    'island.created': 'プライベートの島を作りました — 招待コード {code}',
    'island.moved': '{name} に来ました',
    'island.public': 'みんなの島',
    'island.private': 'プライベートの島 {code}',

    'fish.bite': 'かかった！',
    'fish.escaped.early': '早すぎて逃げられた',
    'fish.escaped.late': '遅かった、逃げられた',
    'fish.escaped.moved': '離れたので糸を巻いた',
    'fish.escaped.stopped': '糸を巻いた',
    'fish.escaped.busy': 'もう釣りをしています',
    'omikuji.again': '今日はもう引きました。今日のおみくじです',
    'stamp.got': '「{place}」のスタンプを押した（{n}/{total}）',
    'stamp.already': 'ここのスタンプはもう押してあります',
    'firework.notHere': '花火は海辺（浜か南港）で上げられます',
    'quiz.eliminated': '不正解……また挑戦しよう！',
    'quiz.survived': '正解！',
    'quiz.won': '🏆 ○×クイズで優勝！',
  },

  en: {
    'event.catch': '🎣 {name} landed a {size} cm {fish}',
    'event.catchRecord': '🎣 {name} landed a {size} cm {fish} — the biggest today!',
    'event.omikuji': '⛩️ {name} drew {fortune}',
    'event.stampComplete': '🗺️ {name} collected every stamp on the island!',
    'event.dice': '🎲 {name} rolled {value} (1–{sides})',
    'event.jankenWin': '✌️ {winner} beat {loser} at janken',
    'event.jankenDraw': '✌️ {a} and {b} drew at janken',
    'event.badge': '{icon} {name} earned “{badge}”',

    'whisper.to': 'Whisper → {name}',
    'whisper.from': '{name} whispers',

    'hand.rock': 'Rock',
    'hand.paper': 'Paper',
    'hand.scissors': 'Scissors',

    'island.created': 'Your private island is ready — code {code}',
    'island.moved': 'Arrived at {name}',
    'island.public': 'Public island',
    'island.private': 'Private island {code}',

    'fish.bite': 'A bite!',
    'fish.escaped.early': 'Too early — it got away',
    'fish.escaped.late': 'Too slow — it got away',
    'fish.escaped.moved': 'You walked off; line in',
    'fish.escaped.stopped': 'Line in',
    'fish.escaped.busy': 'You are already fishing',
    'omikuji.again': 'You already drew today — here is your slip',
    'stamp.got': 'Stamped: {place} ({n}/{total})',
    'stamp.already': 'You already have this stamp',
    'firework.notHere': 'Fireworks go up from the shore (the beach or the south harbour)',
    'quiz.eliminated': 'Wrong… next time!',
    'quiz.survived': 'Correct!',
    'quiz.won': '🏆 You won the ○× quiz!',
  },
};
