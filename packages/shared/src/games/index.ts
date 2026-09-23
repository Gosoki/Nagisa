/**
 * The island's games, as data: what can be caught, drawn, earned and asked.
 *
 * Rules that need authority (who caught what, who answered right) run on the server;
 * this is the part both sides must agree on — the tables, the words, and the clock.
 */
export * from './island-time.js';
export * from './fish.js';
export * from './omikuji.js';
export * from './badges.js';
export * from './quiz-bank.js';
export * from './treasure.js';
export * from './weather.js';
export * from './daily.js';
