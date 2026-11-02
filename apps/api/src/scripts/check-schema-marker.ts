// Fails a release that migrates any database since the previous release unless CHANGELOG.md marks it (full backup).
// A migration is a db-config.ts whose currentVersion moved, or a column ensureAuthSchemaColumns adds to users3.db. A
// rollback after a Light backup starts the build before the update on today's data, and that build may not open a
// migrated database, so a migration needs the Full backup the mark makes ./eigen update take. publish.yml runs it on
// a version tag, and with --main on a push to main, where the mark goes under [Unreleased].

import { readFileSync } from 'node:fs';
import { ROOT, VERSION_PATTERN } from '../cli/install';
import { CHANGELOG_PATH, FULL_BACKUP_MARKER, releaseNotes } from '../cli/update-check';

// The databases of one release: the currentVersion of each versioned one by its name, and the users3.db columns
// ensureAuthSchemaColumns adds, as table.column.
export type Schemas = { versions: ReadonlyMap<string, number>; authColumns: ReadonlySet<string> };

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
const DB_CONFIG_FILES = 'apps/api/src/lib/*/*db-config.ts';
// A literal, or a constant the file declares, such as the mount config's.
const CURRENT_VERSION = /currentVersion:\s*(\w+)/;
const NAME = /name:\s*'([^']+)'/;
// Read from every auth file, since the function has not always lived in one place.
const AUTH_FILES = 'apps/api/src/lib/auth/*.ts';
const AUTH_COLUMN = /ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g;

// Exit code 1 is git grep finding nothing, which is an answer.
function git(args: readonly string[]): string {
    const run = Bun.spawnSync(['git', ...args], { cwd: ROOT });
    if (run.exitCode > 1) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString().trim()}`);
    return run.stdout.toString();
}

// Why this checkout cannot be checked, or null: a shallow clone has no tags below it, so it would read as the first
// release and pass.
export function shallowCloneError(): string | null {
    if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'true') return null;
    return 'This checkout is a shallow clone, so the release before it cannot be read. Check it out with full history (fetch-depth: 0).';
}

// The release `version` follows: the highest release tag below it, so a backport compares with its own line.
// Prerelease tags are skipped, so a release whose candidates' sections were folded into its own still compares
// with the release before them. On main, package.json keeps the version of the last release until the next one, so
// there it is the highest release tag up to `version`.
export function previousRelease(tags: readonly string[], version: string, onMain = false): string | null {
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

// Every database's currentVersion at `ref`, by the name its db-config.ts gives it there, one config a file. Read with
// git grep and git show: a worktree of a tag would resolve @workspace/* through this checkout's node_modules.
export function schemaVersionsAt(ref: string): Map<string, number> {
    const versions = new Map<string, number>();
    const files = git(['grep', '-l', 'currentVersion:', ref, '--', DB_CONFIG_FILES]).split('\n').filter(Boolean);
    for (const file of files) {
        const source = git(['show', file]);
        const name = NAME.exec(source)?.[1];
        const value = CURRENT_VERSION.exec(source)?.[1] ?? '';
        const version = /^\d+$/.test(value) ? value : new RegExp(`const ${value} = (\\d+);`).exec(source)?.[1];
        if (!name || !version) throw new Error(`${file} declares no name or currentVersion this check can read`);
        if (versions.has(name)) throw new Error(`two db-config.ts files at ${ref} name the database ${name}`);
        versions.set(name, Number(version));
    }
    return versions;
}

// The users3.db columns ensureAuthSchemaColumns adds at `ref`, as table.column. That database has no versioned
// migrations, so a column added there is its migration.
export function authColumnsAt(ref: string): Set<string> {
    const columns = new Set<string>();
    const files = git(['grep', '-l', 'ADD COLUMN', ref, '--', AUTH_FILES]).split('\n').filter(Boolean);
    for (const file of files) {
        for (const [, table, column] of git(['show', file]).matchAll(AUTH_COLUMN)) columns.add(`${table}.${column}`);
    }
    return columns;
}

// Why `version` cannot be released, or null: a database it migrated since `previous`, with no (full backup) line in
// the CHANGELOG sections after `previous` up to it, or on main under [Unreleased] too. A database new since `previous`
// has nothing older to migrate.
export function schemaMarkerError(
    changelog: string,
    previous: string,
    version: string,
    before: Schemas,
    after: Schemas,
    onMain = false,
): string | null {
    const moved = [...after.versions].flatMap(([name, currentVersion]) => {
        const old = before.versions.get(name);
        return old === undefined || old === currentVersion ? [] : [`${name} ${old} → ${currentVersion}`];
    });
    for (const column of after.authColumns) {
        if (!before.authColumns.has(column)) moved.push(`users3.db adds ${column}`);
    }
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
    const previous = previousRelease(git(['tag', '--list', 'v*']).split('\n'), version, onMain);
    if (!previous) {
        console.log(`No release before ${version} to compare with.`);
        process.exit(0);
    }
    const schemasAt = (ref: string): Schemas => ({ versions: schemaVersionsAt(ref), authColumns: authColumnsAt(ref) });
    const error = schemaMarkerError(
        readFileSync(CHANGELOG_PATH, 'utf8'),
        previous,
        version,
        schemasAt(`v${previous}`),
        schemasAt('HEAD'),
        onMain,
    );
    if (error) {
        console.error(error);
        process.exit(1);
    }
    console.log(`No database moved since ${previous} without ${FULL_BACKUP_MARKER}.`);
}
