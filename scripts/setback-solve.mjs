#!/usr/bin/env node
/**
 * Runner for the setback solver. Same bundling as the audits; see `lib/bundle-run.mjs`.
 */

import { bundleAndRun } from './lib/bundle-run.mjs';

bundleAndRun('setback-solve');
