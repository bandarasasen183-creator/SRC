// scripts/stamp-version.mjs writes the build marker that tells us which commit
// a deployed site is actually serving. It shipped with a bug that reported
// EVERY clean tree as dirty — `git status --porcelain` returns nothing when the
// tree is clean, and a `|| fallback` turned that empty string into "unknown".
// A dirty flag that is always true is worse than no flag, so it gets a test.
//
// These run the real script against throwaway git repos rather than mocking
// git, because the bug lived in how the script read git's output.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'stamp-version.mjs');

let sandbox;

/** A throwaway git repo containing a copy of the script. */
function makeRepo() {
  const dir = mkdtempSync(join(sandbox, 'repo-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');

  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'public'));
  cpSync(script, join(dir, 'scripts', 'stamp-version.mjs'));
  writeFileSync(join(dir, '.gitignore'), 'public/version.json\n');
  writeFileSync(join(dir, 'README.md'), 'hello\n');

  run('add', '-A');
  run('commit', '-qm', 'initial commit');
  return dir;
}

function stamp(dir) {
  const stdout = execFileSync(process.execPath, ['scripts/stamp-version.mjs'], {
    cwd: dir, encoding: 'utf8',
  });
  const json = JSON.parse(readFileSync(join(dir, 'public', 'version.json'), 'utf8'));
  return { stdout, json };
}

describe('version stamp', () => {
  before(() => { sandbox = mkdtempSync(join(tmpdir(), 'stamp-')); });
  after(() => { rmSync(sandbox, { recursive: true, force: true }); });

  test('a clean tree is NOT reported as dirty', () => {
    const { stdout, json } = stamp(makeRepo());
    assert.equal(json.dirty, false);
    assert.doesNotMatch(stdout, /WARNING/);
    assert.doesNotMatch(stdout, /DIRTY/);
  });

  test('an ignored file does not make the tree dirty', () => {
    const dir = makeRepo();
    // version.json is written by this very script on every deploy. If being
    // ignored didn't count as clean, the flag would latch on after run one.
    stamp(dir);
    const { json } = stamp(dir);
    assert.equal(json.dirty, false);
  });

  test('a modified tracked file IS reported as dirty, and named', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    const { stdout, json } = stamp(dir);
    assert.equal(json.dirty, true);
    assert.match(stdout, /DIRTY WORKING TREE/);
    assert.match(stdout, /README\.md/);
  });

  test('an untracked file IS reported as dirty, and named', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'leftover.txt'), 'scratch\n');
    const { stdout, json } = stamp(dir);
    assert.equal(json.dirty, true);
    assert.match(stdout, /leftover\.txt/);
  });

  test('records the commit actually checked out', () => {
    const dir = makeRepo();
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: dir, encoding: 'utf8' }).trim();
    const { json } = stamp(dir);
    assert.equal(json.sha, head);
    assert.equal(json.subject, 'initial commit');
    assert.match(json.builtAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('outside a git repo it still writes a file rather than failing the deploy', () => {
    const bare = mkdtempSync(join(sandbox, 'nogit-'));
    mkdirSync(join(bare, 'scripts'));
    mkdirSync(join(bare, 'public'));
    cpSync(script, join(bare, 'scripts', 'stamp-version.mjs'));
    const { json } = stamp(bare);
    assert.equal(json.sha, 'unknown');
  });
});
