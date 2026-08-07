#!/usr/bin/env node
/**
 * Runner for the terrain walkability audit.
 *
 * The audit imports workspace TypeScript, so it is bundled before Node runs it. See
 * `lib/bundle-run.mjs` — including for why the scratch it uses lives in `.tmp/`.
 */

import { bundleAndRun } from './lib/bundle-run.mjs';

bundleAndRun('terrain-audit');
