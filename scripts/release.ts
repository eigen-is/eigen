#!/usr/bin/env bun
// Cut a release: `bun run release [patch|minor|major]` bumps package.json and lists the commits since the last
// tag for the CHANGELOG, and `bun run release publish` creates the GitHub Release from the version's CHANGELOG intro.

import { join } from 'node:path';
import { $ } from 'bun';

const REPO_ROOT = join(import.meta.dir, '..');
const PKG_PATH = join(REPO_ROOT, 'package.json');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');

type Bump = 'patch' | 'minor' | 'major';

const arg = process.argv[2] ?? 'patch';

// `bun run release publish [--publish]` — create the GitHub Release for the version in
// package.json, its notes the intro of that version's CHANGELOG.md section. Draft by default,
// so it can be reviewed on GitHub before it goes live.
if (arg === 'publish') {
    const pkg = await Bun.file(PKG_PATH).json();
    const version: string = pkg.version;
    const tag = `v${version}`;

    if ((await $`gh --version`.nothrow().quiet()).exitCode !== 0) {
        console.error(
            'GitHub CLI (gh) is required. Install and authenticate first:\n  brew install gh && gh auth login',
        );
        process.exit(1);
    }

    const lines = (await Bun.file(CHANGELOG_PATH).text()).split('\n');
    const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    if (start === -1) {
        console.error(`No CHANGELOG.md section for [${version}]. Fill it in before publishing.`);
        process.exit(1);
    }
    // The notes are the section's intro, the lines before its first `###`, and a link to the CHANGELOG, so a reader
    // new to Eigen gets the release in a few lines.
    const intro: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith('#')) break;
        if (line.trim()) intro.push(line.trim());
    }
    if (intro.length === 0) {
        console.error(`The CHANGELOG.md section for [${version}] has no intro paragraph. Write one before publishing.`);
        process.exit(1);
    }
    const notes = `${intro.join('\n\n')}\n\nEverything that changed: [CHANGELOG.md](https://github.com/eigen-is/eigen/blob/${tag}/CHANGELOG.md)`;

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

const pkg = await Bun.file(PKG_PATH).json();
const current: string = pkg.version;
const [major, minor, patch] = current.split('.').map(Number);
const next =
    bump === 'major'
        ? `${major + 1}.0.0`
        : bump === 'minor'
          ? `${major}.${minor + 1}.0`
          : `${major}.${minor}.${patch + 1}`;

pkg.version = next;
await Bun.write(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

const lastTag = (await $`git describe --tags --abbrev=0`.nothrow().quiet()).stdout.toString().trim();
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const log = (await $`git log ${range} --pretty=format:%s --no-merges`.quiet()).stdout.toString().trim();

console.log(`\nBumped ${current} → ${next}\n`);
console.log(`Commits since ${lastTag || 'the start'}:\n`);
console.log(log || '  (none)');
console.log(`
Next steps:
  1. Fill the [Unreleased] section in CHANGELOG.md from the commits above.
     Tip: ask Claude to do it (the changelog skill, user-visible only).
  2. Move that block under a new heading: ## [${next}] - ${new Date().toISOString().slice(0, 10)}
  3. Write the intro under that heading: two to five plain sentences for someone new to Eigen.
     It is the whole GitHub Release, with a link to the full section.
  4. Commit on develop, fast-forward main to it and tag main:
       git add package.json CHANGELOG.md
       git commit -m "chore: release v${next}"
       git push origin develop
       git switch main && git merge --ff-only develop
       git tag -a v${next} -m "v${next}"
       git push origin main v${next}
     The tag push runs the Publish workflow: the release gate, then the images to GHCR, :latest last.
  5. Once it is green, publish the GitHub Release (draft for review) from the section's intro:
       bun run release publish
     Review it on GitHub and click Publish, or publish directly with:
       bun run release publish --publish
  6. Update eigen.is to v${next}: it serves https://eigen.is/install from its own build, so the installer changes only then.
`);
