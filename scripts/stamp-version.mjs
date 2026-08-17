#!/usr/bin/env node
/**
 * Write public/version.json just before a hosting deploy.
 *
 * Why this exists: we spent a release arguing about whether a fix was live.
 * Nobody could tell, because a deployed site looks identical whether it is
 * running today's code or last week's. Now anyone can open
 *   https://<site>.web.app/version.json
 * and read the exact commit that is serving.
 *
 * Wired as a hosting "predeploy" hook in firebase.json, so it runs no matter
 * how the deploy is started — scripts/deploy.sh, a bare `firebase deploy`, CI.
 */

import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a git command, or return a placeholder — never fail the deploy for this. */
function git(args, fallback = 'unknown') {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

const sha = git('rev-parse --short HEAD');
const dirty = git('status --porcelain') !== '';

const info = {
  sha,
  // A deploy from a dirty tree is not reproducible from the commit alone.
  // Say so, rather than reporting a SHA that does not describe what shipped.
  dirty,
  branch: git('rev-parse --abbrev-ref HEAD'),
  subject: git('log -1 --pretty=%s'),
  committedAt: git('log -1 --pretty=%cI'),
  builtAt: new Date().toISOString(),
};

const out = join(root, 'public', 'version.json');
writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`);

console.log(
  `Stamped version.json: ${info.sha}${dirty ? ' (DIRTY WORKING TREE)' : ''}` +
  ` on ${info.branch} — "${info.subject}"`
);
if (dirty) {
  console.log(
    'WARNING: you have uncommitted changes. What you deploy will not match ' +
    'the commit above. Commit and push first if you want them to line up.'
  );
}
