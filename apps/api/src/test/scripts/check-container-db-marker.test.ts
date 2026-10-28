import { describe, expect, spyOn, test } from 'bun:test';
import { CONTAINER_DB_CONFIGS } from '../../lib/backup/archive-layout';
import {
    containerDbMarkerError,
    containerDbVersionsAt,
    previousRelease,
    shallowCloneError,
} from '../../scripts/check-container-db-marker';

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
const before = new Map([
    ['collab', 1],
    ['chatroom', 2],
    ['comment-index', 5],
]);
const unmoved = [...before].map(([name, currentVersion]) => ({ name, currentVersion }));
const moved = unmoved.map((db) => (db.name === 'comment-index' ? { ...db, currentVersion: 6 } : db));

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

describe('containerDbMarkerError', () => {
    test('a container database moved without the marker fails, naming it, its versions and the marker', () => {
        const error = containerDbMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, moved);
        expect(error).toContain('comment-index 5 → 6');
        expect(error).toContain('(full backup)');
        expect(error).not.toContain('chatroom');
    });

    test('a move with the marker in the release section passes', () => {
        expect(containerDbMarkerError(marked, '0.3.2', '0.3.3', before, moved)).toBeNull();
    });

    test('nothing moved passes without the marker, and a database new since the previous release is no move', () => {
        expect(containerDbMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, unmoved)).toBeNull();
        const added = [...unmoved, { name: 'whiteboard', currentVersion: 3 }];
        expect(containerDbMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, added)).toBeNull();
    });

    test('a marker under [Unreleased] or under the previous release does not count', () => {
        expect(containerDbMarkerError(CHANGELOG, '0.3.2', '0.3.3', before, moved)).not.toBeNull();
    });

    test('on main, a move since the release it runs on passes with the marker under [Unreleased] and fails without', () => {
        expect(containerDbMarkerError(CHANGELOG, '0.3.3', '0.3.3', before, moved, true)).toBeNull();
        const unmarked = CHANGELOG.replace('**Chat (full backup)**', '**Chat**');
        const error = containerDbMarkerError(unmarked, '0.3.3', '0.3.3', before, moved, true);
        expect(error).toContain('comment-index 5 → 6');
        expect(error).toContain('under ## [Unreleased]');
    });
});

describe('containerDbVersionsAt', () => {
    test("reads at HEAD the versions the configs declare, so the git grep and the regex follow the files' shape", () => {
        const declared = new Map(
            Object.values(CONTAINER_DB_CONFIGS).map(({ name, currentVersion }) => [name, currentVersion]),
        );
        expect(containerDbVersionsAt('HEAD')).toEqual(declared);
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
