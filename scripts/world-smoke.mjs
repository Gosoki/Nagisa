#!/usr/bin/env node
/**
 * Runner for the world-generation smoke test.
 *
 * `world-smoke.ts` imports client TypeScript directly, so it needs bundling before Node can
 * run it. `three` is left external — see `lib/bundle-run.mjs`, which is also where the
 * scratch directory's location and lifetime are explained.
 */

import { bundleAndRun } from './lib/bundle-run.mjs';

bundleAndRun('world-smoke');
