#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';

const REPO_ROOT = join(import.meta.dir, '..');
const PKG_PATH = join(REPO_ROOT, 'package.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');

type Bump = 'patch' | 'minor' | 'major';

const arg = process.argv[2] ?? 'patch';

// `bun run release publish [--publish]` — create the GitHub Release for the version in
// package.json, using that version's CHANGELOG.md section as the notes. Draft by default,
// so it can be reviewed on GitHub before it goes live.
if (arg === 'publish') {
    const pkg = JSON.parse(await readFile(PKG_PATH, 'utf8'));
    const version: string = pkg.version;
    const tag = `v${version}`;

    if ((await $`gh --version`.nothrow().quiet()).exitCode !== 0) {
        console.error(
            'GitHub CLI (gh) is required. Install and authenticate first:\n  brew install gh && gh auth login',
        );
        process.exit(1);
    }

    const lines = (await readFile(CHANGELOG_PATH, 'utf8')).split('\n');
    const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    if (start === -1) {
        console.error(`No CHANGELOG.md section for [${version}]. Fill it in before publishing.`);
        process.exit(1);
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## [')) {
            end = i;
            break;
        }
    }
    const notes = lines
        .slice(start + 1, end)
        .join('\n')
        .trim();

    const draftFlag = process.argv.includes('--publish') ? [] : ['--draft'];
    // --verify-tag aborts if the tag isn't on the remote, so gh never creates a stray tag.
    const result =
        await $`gh release create ${tag} --title ${tag} --notes ${notes} --verify-tag ${draftFlag}`.nothrow();
    if (result.exitCode !== 0) process.exit(result.exitCode);

    console.log(
        draftFlag.length
            ? `\nDrafted GitHub Release ${tag}. Review it on GitHub, then click Publish (or re-run with --publish).`
            : `\nPublished GitHub Release ${tag}.`,
    );
    process.exit(0);
}

if (arg !== 'patch' && arg !== 'minor' && arg !== 'major') {
    console.error('Usage: bun run release [patch|minor|major]\n       bun run release publish [--publish]');
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
  4. Publish the GitHub Release (draft for review) from the new CHANGELOG section:
       bun run release publish
     Review it on GitHub and click Publish, or publish directly with:
       bun run release publish --publish
`);
