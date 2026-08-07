#!/usr/bin/env node
/**
 * Runner for the jaggedness audit. See `lib/bundle-run.mjs`.
 */

import { bundleAndRun } from './lib/bundle-run.mjs';

bundleAndRun('jaggedness');
