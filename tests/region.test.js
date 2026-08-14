/**
 * The browser and the deployed functions must agree on a region.
 *
 * This is a real bug that shipped: functions deployed to
 * australia-southeast1 while the client called the us-central1 default, so
 * every callable failed with the opaque code "internal" — a teacher clicking
 * "Resend" just saw a red box reading `internal`.
 *
 * The emulator ignores region (connectFunctionsEmulator overrides the host),
 * which is exactly why the browser end-to-end suite passed while production
 * was broken. Hence this static check.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync('public/js/fb.js', 'utf8');
const server = readFileSync('functions/index.js', 'utf8');

describe('cloud functions region', () => {
  test('client declares an explicit region', () => {
    const m = /FUNCTIONS_REGION\s*=\s*'([^']+)'/.exec(client);
    assert.ok(m, 'public/js/fb.js must export FUNCTIONS_REGION');
    assert.ok(m[1].length > 3, `suspicious region: ${m?.[1]}`);
  });

  test('client passes that region to getFunctions', () => {
    assert.match(
      client,
      /getFunctions\(app,\s*FUNCTIONS_REGION\)/,
      'getFunctions(app) without a region silently defaults to us-central1'
    );
  });

  test('server declares a region', () => {
    assert.match(server, /setGlobalOptions\(\{[^}]*region:\s*'[^']+'/);
  });

  test('the two regions are identical', () => {
    const c = /FUNCTIONS_REGION\s*=\s*'([^']+)'/.exec(client)[1];
    const s = /setGlobalOptions\(\{[^}]*region:\s*'([^']+)'/.exec(server)[1];
    assert.equal(c, s,
      `client calls ${c} but functions deploy to ${s} — every callable will fail with "internal"`);
  });
});

describe('error messages', () => {
  const ui = readFileSync('public/js/ui.js', 'utf8');

  test('the bare "internal" code is translated for humans', () => {
    assert.match(ui, /'internal':/,
      'friendlyError must map "internal" — otherwise a teacher sees the raw code');
  });

  test('a message identical to its code is never shown', () => {
    assert.match(ui, /msg === code/,
      'friendlyError must reject messages that are just the error code repeated');
  });
});
