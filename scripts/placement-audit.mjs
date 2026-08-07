#!/usr/bin/env node
/**
 * Runner for the building placement audit. Same bundling as the terrain audit; see
 * `lib/bundle-run.mjs`.
 */

import { bundleAndRun } from './lib/bundle-run.mjs';

bundleAndRun('placement-audit');
