// Fails a release that migrates a container's database since the previous release unless CHANGELOG.md marks it
// (full backup): a Light backup leaves those databases out, so only the Full one the marker gets ./eigen update to make
// lets a rollback bring them back. publish.yml runs it on a version tag.
//
// Usage: bun apps/api/src/scripts/check-container-db-marker.ts <version>
//
// The previous release's versions come from its tag through git grep and git show: a worktree of the tag would resolve
// @workspace/* through this checkout's node_modules.
import { readFileSync } from 'node:fs';
import { ROOT, VERSION_PATTERN } from '../cli/install';
import { CHANGELOG_PATH, FULL_BACKUP_MARKER, releaseNotes } from '../cli/update-check';
import { CONTAINER_DB_CONFIGS } from '../lib/backup/archive-layout';

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
const DB_CONFIG_FILES = 'apps/api/src/lib/*/*db-config.ts';
const CURRENT_VERSION = /currentVersion:\s*(\d+)/;

type ContainerDbVersion = { name: string; currentVersion: number };

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
// with the release before them.
export function previousRelease(tags: string[], version: string): string | null {
    let previous: string | null = null;
    for (const tag of tags) {
        const release = RELEASE_TAG.exec(tag)?.[1];
        if (!release || Bun.semver.order(release, version) >= 0) continue;
        if (!previous || Bun.semver.order(release, previous) > 0) previous = release;
    }
    return previous;
}

// Each container database's currentVersion at `ref`, from the db-config.ts that names it there. A database none
// names there is new since, with nothing older to migrate.
export function containerDbVersionsAt(ref: string): Map<string, number> {
    const versions = new Map<string, number>();
    for (const { name } of Object.values(CONTAINER_DB_CONFIGS)) {
        const [file, ...others] = git(['grep', '-l', `name: '${name}'`, ref, '--', DB_CONFIG_FILES])
            .stdout.split('\n')
            .filter(Boolean);
        if (!file) {
            console.log(`${name} is new since ${ref}.`);
            continue;
        }
        if (others.length > 0) throw new Error(`${[file, ...others].join(', ')} all name the database ${name}`);
        const version = CURRENT_VERSION.exec(git(['show', file]).stdout)?.[1];
        if (!version) throw new Error(`${file} declares no literal currentVersion`);
        versions.set(name, Number(version));
    }
    return versions;
}

// Why `version` cannot be released, or null: a container database it moved since `previous`, with no (full backup)
// line in the CHANGELOG sections after `previous` up to it.
export function containerDbMarkerError(
    changelog: string,
    previous: string,
    version: string,
    before: ReadonlyMap<string, number>,
    after: ContainerDbVersion[],
): string | null {
    const moved = after.flatMap(({ name, currentVersion }) => {
        const old = before.get(name);
        return old === undefined || old === currentVersion ? [] : [`${name} ${old} → ${currentVersion}`];
    });
    if (moved.length === 0) return null;
    if (releaseNotes(changelog, previous, version).some(({ fullBackup }) => fullBackup.length > 0)) return null;
    return `Eigen ${version} migrates container databases since ${previous} (${moved.join(', ')}), which a Light backup leaves out. Mark the change ${FULL_BACKUP_MARKER} under ## [${version}] in CHANGELOG.md, so ./eigen update makes a Full backup first.`;
}

if (import.meta.main) {
    const [version] = Bun.argv.slice(2);
    if (!version || !VERSION_PATTERN.test(version)) {
        console.error('Usage: bun apps/api/src/scripts/check-container-db-marker.ts <version>');
        process.exit(1);
    }
    const shallow = shallowCloneError();
    if (shallow) {
        console.error(shallow);
        process.exit(1);
    }
    const previous = previousRelease(git(['tag', '--list', 'v*']).stdout.split('\n'), version);
    if (!previous) {
        console.log(`No release before ${version} to compare with.`);
        process.exit(0);
    }
    const after = Object.values(CONTAINER_DB_CONFIGS).map(({ name, currentVersion }) => ({ name, currentVersion }));
    const error = containerDbMarkerError(
        readFileSync(CHANGELOG_PATH, 'utf8'),
        previous,
        version,
        containerDbVersionsAt(`v${previous}`),
        after,
    );
    if (error) {
        console.error(error);
        process.exit(1);
    }
    console.log(`No container database moved since ${previous} without ${FULL_BACKUP_MARKER}.`);
}
