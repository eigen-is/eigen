#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';

const REPO_ROOT = join(import.meta.dir, '..');
const PKG_PATH = join(REPO_ROOT, 'package.json');

type Bump = 'patch' | 'minor' | 'major';

const arg = process.argv[2] ?? 'patch';
if (arg !== 'patch' && arg !== 'minor' && arg !== 'major') {
    console.error(`Usage: bun run release [patch|minor|major]`);
    process.exit(1);
}
const bump: Bump = arg;

const pkgRaw = await readFile(PKG_PATH, 'utf8');
const pkg = JSON.parse(pkgRaw);
const current: string = pkg.version;
const [major, minor, patch] = current.split('.').map(Number);
const next =
    bump === 'major'
        ? `${major + 1}.0.0`
        : bump === 'minor'
          ? `${major}.${minor + 1}.0`
          : `${major}.${minor}.${patch + 1}`;

pkg.version = next;
await writeFile(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

const lastTag = (await $`git describe --tags --abbrev=0`.nothrow().quiet()).stdout.toString().trim();
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const log = (await $`git log ${range} --pretty=format:%s --no-merges`.quiet()).stdout.toString().trim();

console.log(`\nBumped ${current} → ${next}\n`);
console.log(`Commits since ${lastTag || 'the start'}:\n`);
console.log(log || '  (none)');
console.log(`
Next steps:
  1. Fill the [Unreleased] section in CHANGELOG.md from the commits above.
     Tip: ask Claude to do it (Keep-a-Changelog format, user-visible only).
  2. Move that block under a new heading: ## [${next}] - ${new Date().toISOString().slice(0, 10)}
  3. Commit and tag:
       git add package.json CHANGELOG.md
       git commit -m "chore: release v${next}"
       git tag -a v${next} -m "v${next}"
       git push --follow-tags
`);
