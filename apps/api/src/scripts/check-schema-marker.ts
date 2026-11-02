// Fails a release that migrates any database since the previous release unless CHANGELOG.md marks it (full backup).
// A rollback after a Light backup keeps the data as it is and starts the build before the update, which refuses a
// schema newer than its own. So only the Full backup the marker gets ./eigen update to make lets a rollback go back
// over a migration. publish.yml runs it on a version tag, and with --main on a push to main, where the mark goes under
// [Unreleased] since the main channel reads it there.
//
// Usage: bun apps/api/src/scripts/check-schema-marker.ts <version> [--main]
//
// The previous release's versions come from its tag through git grep and git show: a worktree of the tag would resolve
// @workspace/* through this checkout's node_modules.
import { readFileSync } from 'node:fs';
import { ROOT, VERSION_PATTERN } from '../cli/install';
import { CHANGELOG_PATH, FULL_BACKUP_MARKER, releaseNotes } from '../cli/update-check';

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
const DB_CONFIG_FILES = 'apps/api/src/lib/*/*db-config.ts';
// A literal, or a constant the file declares, such as the mount config's.
const CURRENT_VERSION = /currentVersion:\s*(\w+)/;
const NAME = /name:\s*'([^']+)'/;

function git(args: string[]): { code: number; stdout: string } {
    const run = Bun.spawnSync(['git', ...args], { cwd: ROOT });
    if (run.exitCode > 1) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString().trim()}`);
    return { code: run.exitCode, stdout: run.stdout.toString() };
}

// Why this checkout cannot be checked, or null: a shallow clone has no tags below it, so it would read as the first
// release and pass.
export function shallowCloneError(): string | null {
    if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'true') return null;
    return 'This checkout is a shallow clone, so the release before it cannot be read. Check it out with full history (fetch-depth: 0).';
}

// The release `version` follows: the highest release tag below it, so a backport compares with its own line.
// Prerelease tags are skipped, so a release whose candidates' sections were folded into its own still compares
// with the release before them. On main, package.json keeps the version of the last release until the next one, so
// there it is the highest release tag up to `version`.
export function previousRelease(tags: string[], version: string, onMain = false): string | null {
    let previous: string | null = null;
    for (const tag of tags) {
        const release = RELEASE_TAG.exec(tag)?.[1];
        if (!release) continue;
        const order = Bun.semver.order(release, version);
        if (order > 0 || (order === 0 && !onMain)) continue;
        if (!previous || Bun.semver.order(release, previous) > 0) previous = release;
    }
    return previous;
}

// Every database's currentVersion at `ref`, by the name its db-config.ts gives it there, one config a file.
export function schemaVersionsAt(ref: string): Map<string, number> {
    const versions = new Map<string, number>();
    const files = git(['grep', '-l', 'currentVersion:', ref, '--', DB_CONFIG_FILES]).stdout.split('\n').filter(Boolean);
    for (const file of files) {
        const source = git(['show', file]).stdout;
        const name = NAME.exec(source)?.[1];
        const value = CURRENT_VERSION.exec(source)?.[1] ?? '';
        const version = /^\d+$/.test(value) ? value : new RegExp(`const ${value} = (\\d+);`).exec(source)?.[1];
        if (!name || !version) throw new Error(`${file} declares no literal name and currentVersion`);
        if (versions.has(name)) throw new Error(`two db-config.ts files at ${ref} name the database ${name}`);
        versions.set(name, Number(version));
    }
    return versions;
}

// Why `version` cannot be released, or null: a database it moved since `previous`, with no (full backup) line in the
// CHANGELOG sections after `previous` up to it, or on main under [Unreleased] too. A database new since `previous` has
// nothing older to migrate.
export function schemaMarkerError(
    changelog: string,
    previous: string,
    version: string,
    before: ReadonlyMap<string, number>,
    after: { name: string; currentVersion: number }[],
    onMain = false,
): string | null {
    const moved = after.flatMap(({ name, currentVersion }) => {
        const old = before.get(name);
        return old === undefined || old === currentVersion ? [] : [`${name} ${old} → ${currentVersion}`];
    });
    if (moved.length === 0) return null;
    const notes = releaseNotes(changelog, previous, version, { unreleased: onMain });
    if (notes.some(({ fullBackup }) => fullBackup.length > 0)) return null;
    const build = onMain ? 'This build of main' : `Eigen ${version}`;
    const section = onMain ? 'Unreleased' : version;
    return `${build} migrates databases since ${previous} (${moved.join(', ')}), which the build before it cannot open. Mark the change ${FULL_BACKUP_MARKER} under ## [${section}] in CHANGELOG.md, so ./eigen update makes a Full backup first and ./eigen rollback restores it.`;
}

if (import.meta.main) {
    const [version, channel, ...rest] = Bun.argv.slice(2);
    const onMain = channel === '--main';
    if (!version || !VERSION_PATTERN.test(version) || (channel !== undefined && !onMain) || rest.length > 0) {
        console.error('Usage: bun apps/api/src/scripts/check-schema-marker.ts <version> [--main]');
        process.exit(1);
    }
    const shallow = shallowCloneError();
    if (shallow) {
        console.error(shallow);
        process.exit(1);
    }
    const previous = previousRelease(git(['tag', '--list', 'v*']).stdout.split('\n'), version, onMain);
    if (!previous) {
        console.log(`No release before ${version} to compare with.`);
        process.exit(0);
    }
    const after = [...schemaVersionsAt('HEAD')].map(([name, currentVersion]) => ({ name, currentVersion }));
    const error = schemaMarkerError(
        readFileSync(CHANGELOG_PATH, 'utf8'),
        previous,
        version,
        schemaVersionsAt(`v${previous}`),
        after,
        onMain,
    );
    if (error) {
        console.error(error);
        process.exit(1);
    }
    console.log(`No database moved since ${previous} without ${FULL_BACKUP_MARKER}.`);
}
