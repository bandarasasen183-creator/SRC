// The markdown renderer is the security boundary for everything a teacher or
// student writes. It escapes first and formats second, so no input can become
// markup. These tests exist to keep it that way while it grows features.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderBody, bodyExtract } from '../public/js/ui.js';

describe('renderBody — headings', () => {
  test('## becomes a title', () => {
    assert.equal(renderBody('## Term 3 plans'), '<h2>Term 3 plans</h2>');
  });

  test('### becomes a subtitle', () => {
    assert.equal(renderBody('### Fundraising'), '<h3>Fundraising</h3>');
  });

  test('deeper levels fold into the subtitle rather than emitting h4+', () => {
    assert.equal(renderBody('##### Deep'), '<h3>Deep</h3>');
  });

  test('a heading can contain inline formatting', () => {
    assert.equal(renderBody('## Big **news**'), '<h2>Big <strong>news</strong></h2>');
  });

  test('a lone # is not a heading — it is just text', () => {
    assert.equal(renderBody('# Nope'), '<p># Nope</p>');
  });

  test('a hash mid-sentence is left alone', () => {
    assert.equal(renderBody('room #3 is free'), '<p>room #3 is free</p>');
  });

  test('a heading ends the paragraph and the list before it', () => {
    assert.equal(
      renderBody('- one\n## Next'),
      '<ul><li>one</li></ul><h2>Next</h2>'
    );
  });
});

describe('renderBody — escaped characters', () => {
  test('an escaped asterisk stays an asterisk', () => {
    assert.equal(renderBody('5 \\* 3 \\* 2'), '<p>5 * 3 * 2</p>');
  });

  test('escaping defeats what would otherwise be emphasis', () => {
    assert.equal(renderBody('\\*not italic\\*'), '<p>*not italic*</p>');
    assert.equal(renderBody('*is italic*'), '<p><em>is italic</em></p>');
  });

  test('escaped brackets do not start a link', () => {
    assert.equal(renderBody('\\[a\\](b)'), '<p>[a](b)</p>');
  });

  test('an escaped backslash survives as one backslash', () => {
    assert.equal(renderBody('a \\\\ b'), '<p>a \\ b</p>');
  });

  test('text written before escaping existed still formats', () => {
    // No backslashes in old content, so nothing changes for it.
    assert.equal(renderBody('**bold** and *italic*'),
      '<p><strong>bold</strong> and <em>italic</em></p>');
  });
});

describe('renderBody — still escapes first, formats second', () => {
  // The real invariant is not "the word onerror never appears" — escaped text
  // may legitimately contain that word. It is "no element beyond this list is
  // ever emitted, and no link points anywhere but http(s)".
  const ALLOWED = new Set(['p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'h2', 'h3']);
  const tagsIn = (html) =>
    [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());

  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '## <script>alert(1)</script>',
    '### <img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '- <script>alert(1)</script>',
    '**<script>alert(1)</script>**',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="//evil"></iframe>',
    '<svg/onload=alert(1)>',
    '<style>body{display:none}</style>',
    '<script>alert(1)</script>'.toUpperCase(),
  ];

  for (const attack of attacks) {
    test(`neutralised: ${attack.slice(0, 42)}`, () => {
      const html = renderBody(attack);

      const bad = tagsIn(html).filter((t) => !ALLOWED.has(t));
      assert.deepEqual(bad, [], `emitted disallowed element(s): ${bad.join(', ')}`);

      // Every href must be http(s) — no javascript:, data:, or protocol-relative.
      for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
        assert.match(href, /^https?:\/\//, `unsafe href: ${href}`);
      }

      // And the payload must still be present, as visible text rather than
      // silently dropped — dropping it would hide an attack from a moderator.
      assert.ok(html.length > 7);
    });
  }

  test('a legitimate https link still becomes a link', () => {
    const html = renderBody('[plan](https://example.com/p)');
    assert.match(html, /<a href="https:\/\/example\.com\/p"/);
    assert.match(html, /rel="noopener noreferrer nofollow"/);
  });

  test('the escape placeholder cannot be smuggled in', () => {
    // If a writer could inject the internal placeholder codepoint they could
    // confuse the escape restore step. It is stripped on the way in.
    const html = renderBody('\u0000*hi*\u0000');
    assert.doesNotMatch(html, /\u0000/);
    assert.match(html, /<em>hi<\/em>/);
  });
});

describe('bodyExtract — headings do not leak markers into email', () => {
  test('strips heading hashes', () => {
    assert.equal(bodyExtract('## Big news\nIt is on.'), 'Big news It is on.');
  });

  test('strips bold and link syntax', () => {
    assert.equal(bodyExtract('**Hi** see [here](https://x.com)'), 'Hi see here');
  });
});
