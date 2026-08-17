// The importer writes straight into the announcements feed, so bad input must
// be rejected before it becomes documents nobody can easily unpick.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseImport } from '../public/js/import-parse.js';

const one = (o) => JSON.stringify([o]);

describe('parseImport — rejects bad input', () => {
  test('not JSON', () => {
    const { errors } = parseImport('not json at all');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not valid JSON/);
  });

  test('a bare object rather than an array', () => {
    assert.match(parseImport('{"title":"x"}').errors[0], /array/);
  });

  test('a post with no title', () => {
    assert.match(parseImport(one({ body: 'hi' })).errors[0], /needs a title/);
  });

  test('a title over the 200-char rule limit', () => {
    assert.match(parseImport(one({ title: 'x'.repeat(201) })).errors[0], /over 200/);
  });

  test('a body over the 20,000-char rule limit', () => {
    assert.match(parseImport(one({ title: 'x', body: 'y'.repeat(20001) })).errors[0], /20,000/);
  });

  test('a malformed date', () => {
    assert.match(parseImport(one({ title: 'x', date: '13/8/26' })).errors[0], /2026-08-13/);
  });

  test('more posts than the cap', () => {
    const many = JSON.stringify(Array.from({ length: 101 }, () => ({ title: 't' })));
    assert.match(parseImport(many).errors[0], /more than the 100 limit/);
  });

  test('errors name which post is wrong', () => {
    const { errors } = parseImport(JSON.stringify([{ title: 'ok' }, { body: 'no title' }]));
    assert.match(errors[0], /^Post 2:/);
  });

  test('nothing is returned for import when there are errors', () => {
    const { posts } = parseImport(JSON.stringify([{ title: 'ok' }, { body: 'bad' }]));
    assert.deepEqual(posts, []);
  });
});

describe('parseImport — normalises good input', () => {
  test('orders oldest first, because import order becomes feed order', () => {
    const { posts } = parseImport(JSON.stringify([
      { title: 'C', date: '2026-08-17' },
      { title: 'A', date: '2026-08-01' },
      { title: 'B', date: '2026-08-13' },
    ]));
    assert.deepEqual(posts.map((p) => p.title), ['A', 'B', 'C']);
  });

  test('undated posts sort after dated ones', () => {
    const { posts } = parseImport(JSON.stringify([
      { title: 'undated' },
      { title: 'dated', date: '2026-08-01' },
    ]));
    assert.deepEqual(posts.map((p) => p.title), ['dated', 'undated']);
  });

  test('comments default to open, pinning defaults to off', () => {
    const [p] = parseImport(one({ title: 'x' })).posts;
    assert.equal(p.commentsOpen, true);
    assert.equal(p.pinned, false);
  });

  test('explicit flags are honoured', () => {
    const [p] = parseImport(one({ title: 'x', commentsOpen: false, pinned: true })).posts;
    assert.equal(p.commentsOpen, false);
    assert.equal(p.pinned, true);
  });

  test('titles are trimmed', () => {
    assert.equal(parseImport(one({ title: '  spaced  ' })).posts[0].title, 'spaced');
  });

  test('a missing body becomes an empty string, not "undefined"', () => {
    assert.equal(parseImport(one({ title: 'x' })).posts[0].body, '');
  });
});

describe('the shipped Classroom archive is importable as-is', () => {
  const file = readFileSync(new URL('../docs/classroom-import.json', import.meta.url), 'utf8');

  test('parses with no errors', () => {
    const { posts, errors } = parseImport(file);
    assert.deepEqual(errors, []);
    assert.ok(posts.length >= 9, `only ${posts.length} posts`);
  });

  test('every post carries a date and an author', () => {
    for (const p of parseImport(file).posts) {
      assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/, p.title);
      assert.ok(p.authorName, `${p.title} has no author`);
    }
  });
});
