import { Database } from 'bun:sqlite';
import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ROOT } from '../../cli/install';
import { ensureAuthSchemaColumns } from '../../lib/auth/auth-schema-columns';
import {
    authColumnsAt,
    previousRelease,
    schemaMarkerError,
    schemaVersionsAt,
    shallowCloneError,
} from '../../scripts/check-schema-marker';

const CHANGELOG = `# Changelog

## [Unreleased]

- **Chat (full backup)** — not released yet

## [0.3.3] - 2026-10-20

A fix.

- **Comments** — a new column

## [0.3.2] - 2026-10-10

- **Collab (full backup)** — an older release's
`;

const marked = CHANGELOG.replace('- **Comments** — a new column', '- **Comments (full backup)** — a new column');
const versions = new Map([
    ['collab', 1],
    ['mail', 2],
    ['comment-index', 5],
]);
const authColumns = new Set(['user.last_login_at']);
const before = { versions, authColumns };
const unmoved = { versions: new Map(versions), authColumns: new Set(authColumns) };
const moved = { versions: new Map([...versions, ['comment-index', 6]]), authColumns };

describe('previousRelease', () => {
    test('is the highest release tag below the version, for a backport too', () => {
        const tags = ['v0.2.0', 'v0.3.2', 'v0.3.10', 'v0.4.0', 'v0.4.1-rc.1', 'nightly', ''];
        expect(previousRelease(tags, '0.4.1')).toBe('0.4.0');
        expect(previousRelease(tags, '0.3.11')).toBe('0.3.10');
        expect(previousRelease(tags, '0.4.0-rc.2')).toBe('0.3.10');
        expect(previousRelease(tags, '0.2.0')).toBeNull();
    });

    test('on main, whose package.json keeps the last release until the next, is the highest release tag up to it', () => {
        const tags = ['v0.3.10', 'v0.4.0', 'v0.4.1-rc.1'];
        expect(previousRelease(tags, '0.4.0', true)).toBe('0.4.0');
        expect(previousRelease(tags, '0.4.1', true)).toBe('0.4.0');
        expect(previousRelease(tags, '0.3.9', true)).toBeNull();
    });
});

describe('schemaMarkerError', () => {
    test('a database moved without the marker fails, naming it, its versions and the marker', () => {
        const error = schemaMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, moved);
        expect(error).toContain('comment-index 5 → 6');
        expect(error).toContain('(full backup)');
        expect(error).not.toContain('mail');
    });

    test('a database a Light backup holds counts too: the build before cannot open it either', () => {
        const mail = { versions: new Map([...versions, ['mail', 3]]), authColumns };
        expect(schemaMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, mail)).toContain('mail 2 → 3');
    });

    test('a column ensureAuthSchemaColumns adds to users3.db is a migration too, and passes with the marker', () => {
        const added = { versions, authColumns: new Set([...authColumns, 'team.member_count']) };
        expect(schemaMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, added)).toContain(
            'users3.db adds team.member_count',
        );
        expect(schemaMarkerError(marked, '0.3.2', '0.3.3', before, added)).toBeNull();
    });

    test('a move with the marker in the release section passes', () => {
        expect(schemaMarkerError(marked, '0.3.2', '0.3.3', before, moved)).toBeNull();
    });

    test('nothing moved passes without the marker, and a database new since the previous release is no move', () => {
        expect(schemaMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, unmoved)).toBeNull();
        const added = { versions: new Map([...versions, ['whiteboard', 3]]), authColumns };
        expect(schemaMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, added)).toBeNull();
    });

    test('a marker under [Unreleased] or under the previous release does not count', () => {
        expect(schemaMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, moved)).not.toBeNull();
    });

    test('on main, a move since the release it runs on passes with the marker under [Unreleased] and fails without', () => {
        expect(schemaMarkerError(CHANGELOG, '0.3.3', '0.3.3', before, moved, true)).toBeNull();
        const unmarked = CHANGELOG.replace('**Chat (full backup)**', '**Chat**');
        const error = schemaMarkerError(unmarked, '0.3.3', '0.3.3', before, moved, true);
        expect(error).toContain('comment-index 5 → 6');
        expect(error).toContain('under ## [Unreleased]');
    });
});

// Every file in the repo, tests aside, that exports a DatabaseConfig, as git grep finds it at HEAD.
function filesExportingDatabaseConfig(): string[] {
    const pattern = 'export const [A-Za-z0-9_]+: DatabaseConfig<';
    const grep = ['git', 'grep', '-l', '-E', pattern, 'HEAD', '--', 'apps', 'packages', ':!*/test/*'];
    return Bun.spawnSync(grep, { cwd: ROOT })
        .stdout.toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.replace(/^HEAD:/, ''));
}

describe('schemaVersionsAt', () => {
    test('reads at HEAD the name and version of every DatabaseConfig the repo exports, wherever its file is', async () => {
        const declared = new Map<string, number>();
        for (const file of filesExportingDatabaseConfig()) {
            const module: Record<string, unknown> = await import(join(ROOT, file));
            for (const value of Object.values(module)) {
                if (typeof value !== 'object' || value === null || !('name' in value) || !('currentVersion' in value)) {
                    continue;
                }
                if (typeof value.name === 'string' && typeof value.currentVersion === 'number') {
                    declared.set(value.name, value.currentVersion);
                }
            }
        }
        expect(declared.size).toBeGreaterThan(10);
        expect(schemaVersionsAt('HEAD')).toEqual(declared);
    });
});

describe('authColumnsAt', () => {
    test('reads at HEAD every column ensureAuthSchemaColumns adds, so the regex follows its shape', () => {
        // Each table with only the columns the function reads, so it adds every one it knows.
        const db = new Database(':memory:');
        db.run('CREATE TABLE "user" ("id" text)');
        db.run('CREATE TABLE "team" ("id" text)');
        db.run('CREATE TABLE "team_member" ("id" text, "team_id" text)');
        db.run('CREATE TABLE "invitation" ("id" text)');
        db.run('CREATE TABLE "two_factor" ("id" text)');
        const columns = (): string[] =>
            db
                .query<{ table: string; column: string }, []>(
                    `SELECT m.name AS "table", p.name AS "column" FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'`,
                )
                .all()
                .map(({ table, column }) => `${table}.${column}`);
        const old = new Set(columns());
        ensureAuthSchemaColumns(db);
        const added = new Set(columns().filter((column) => !old.has(column)));
        db.close();
        expect(added.size).toBeGreaterThan(0);
        expect(authColumnsAt('HEAD')).toEqual(added);
    });
});

describe('shallowCloneError', () => {
    test('a shallow clone fails rather than reading as the first release', () => {
        const spawnSync = Bun.spawnSync;
        const git = spyOn(Bun, 'spawnSync').mockImplementationOnce(() => spawnSync(['echo', 'true']));
        try {
            expect(shallowCloneError()).toContain('shallow clone');
            expect(git.mock.calls[0]?.[0]).toEqual(['git', 'rev-parse', '--is-shallow-repository']);
        } finally {
            git.mockRestore();
        }
    });

    test('a clone with full history passes', () => {
        const spawnSync = Bun.spawnSync;
        const git = spyOn(Bun, 'spawnSync').mockImplementationOnce(() => spawnSync(['echo', 'false']));
        try {
            expect(shallowCloneError()).toBeNull();
        } finally {
            git.mockRestore();
        }
    });
});
