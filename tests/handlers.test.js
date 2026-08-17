// Guards against a bug class that shipped and stuck a real button forever.
//
// `event.currentTarget` is only set while the event is dispatching. Read it
// after an `await` and it is null. This was in seven handlers:
//
//     busy(e.currentTarget, true, 'Saving…');   // fine, still dispatching
//     await updatePassword(...);
//     busy(e.currentTarget, false);             // null — threw inside catch
//
// Because it threw from inside a catch block, the error handler died and the
// button stayed disabled on "Saving…" with no way back but a page reload. It is
// invisible on the happy path, which is why it survived a browser test suite.
//
// A source scan is the right tool: the failure is a coding pattern, and
// reproducing all seven UI error paths in a browser would be far more code for
// less certainty.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { busy } from '../public/js/ui.js';

const JS_DIR = new URL('../public/js/', import.meta.url).pathname;
const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));

describe('no handler reads event.currentTarget after an await', () => {
  for (const file of files) {
    test(file, () => {
      const src = readFileSync(join(JS_DIR, file), 'utf8');
      const offenders = [];

      src.split('\n').forEach((line, i) => {
        // Strip strings and comments first, otherwise prose that merely
        // mentions the pattern — including the warning text inside busy() —
        // reads as a violation of it.
        const code = line
          .replace(/'(?:[^'\\]|\\.)*'/g, "''")
          .replace(/"(?:[^"\\]|\\.)*"/g, '""')
          .replace(/`(?:[^`\\]|\\.)*`/g, '``')
          .replace(/\/\/.*$/, '')
          .replace(/^\s*\*.*$/, '');

        // Passing currentTarget straight into a call is only safe synchronously,
        // and one line does not say whether an await follows. Capturing it into
        // a variable first (`const btn = e.currentTarget`) always is safe, so
        // require the capture form everywhere and the timing question is gone.
        if (/\.currentTarget/.test(code)
            && !/(?:const|let)\s+\w+\s*=\s*\w+\.currentTarget/.test(code)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });

      assert.deepEqual(offenders, [],
        `Capture the element before any await:\n  const btn = e.currentTarget;\n\n${offenders.join('\n')}`);
    });
  }
});

describe('busy() survives being handed nothing', () => {
  // The element only has to quack like a button, so a plain object is enough
  // and this needs no DOM.
  const fakeButton = () => ({ dataset: {}, disabled: false, textContent: 'Save' });

  test('a null element does not throw', () => {
    // It threw before, from inside a catch block, which is what turned a
    // recoverable error into a permanently dead button.
    assert.doesNotThrow(() => busy(null, false));
    assert.doesNotThrow(() => busy(undefined, true, 'Saving…'));
  });

  test('it disables and relabels a real element', () => {
    const b = fakeButton();
    busy(b, true, 'Saving…');
    assert.equal(b.disabled, true);
    assert.equal(b.textContent, 'Saving…');
  });

  test('and puts the original label back', () => {
    const b = fakeButton();
    busy(b, true, 'Saving…');
    busy(b, false);
    assert.equal(b.disabled, false);
    assert.equal(b.textContent, 'Save');
  });

  test('re-enabling something never disabled is harmless', () => {
    const b = fakeButton();
    busy(b, false);
    assert.equal(b.disabled, false);
    assert.equal(b.textContent, 'Save');
  });
});
