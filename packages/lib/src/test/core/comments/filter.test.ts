import { describe, expect, test } from 'bun:test';
import {
    type CommentFilter,
    DEFAULT_COMMENT_FILTER,
    isCommentFilterActive,
    matchesCommentFilter,
} from '../../../core/comments/filter';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';

function makeCard(overrides: Partial<CommentCard> = {}): CommentCard {
    return { id: 'c1', title: 't', description: 'd', ...overrides };
}

function makeEntry(overrides: Partial<CommentEntry> = {}): CommentEntry {
    return {
        chatName: 'c1.eigenchat',
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
        lastAuthorEmail: null,
        lastMessageSnippet: null,
        lastActivityAt: null,
        messageCount: 0,
        createdAt: new Date(0),
        createdBy: null,
        assignee: null,
        title: null,
        ...overrides,
    };
}

function filter(overrides: Partial<CommentFilter> = {}): CommentFilter {
    return { ...DEFAULT_COMMENT_FILTER, ...overrides };
}

describe('matchesCommentFilter — status', () => {
    test('missing entry counts as open', () => {
        expect(matchesCommentFilter(makeCard(), undefined, filter({ status: 'open' }), 'me@x.com')).toBe(true);
        expect(matchesCommentFilter(makeCard(), undefined, filter({ status: 'resolved' }), 'me@x.com')).toBe(false);
        expect(matchesCommentFilter(makeCard(), undefined, filter({ status: 'all' }), 'me@x.com')).toBe(true);
    });

    test('open entry vs each status', () => {
        const entry = makeEntry({ status: 'open' });
        expect(matchesCommentFilter(makeCard(), entry, filter({ status: 'open' }), 'me@x.com')).toBe(true);
        expect(matchesCommentFilter(makeCard(), entry, filter({ status: 'resolved' }), 'me@x.com')).toBe(false);
        expect(matchesCommentFilter(makeCard(), entry, filter({ status: 'all' }), 'me@x.com')).toBe(true);
    });

    test('resolved entry vs each status', () => {
        const entry = makeEntry({ status: 'resolved' });
        expect(matchesCommentFilter(makeCard(), entry, filter({ status: 'open' }), 'me@x.com')).toBe(false);
        expect(matchesCommentFilter(makeCard(), entry, filter({ status: 'resolved' }), 'me@x.com')).toBe(true);
        expect(matchesCommentFilter(makeCard(), entry, filter({ status: 'all' }), 'me@x.com')).toBe(true);
    });
});

describe('matchesCommentFilter — assignee', () => {
    test("'all' matches regardless of assignee", () => {
        expect(matchesCommentFilter(makeCard(), makeEntry({ assignee: 'a@x.com' }), filter(), 'me@x.com')).toBe(true);
        expect(matchesCommentFilter(makeCard(), undefined, filter(), 'me@x.com')).toBe(true);
    });

    test("'me' compares against lowercased currentUserEmail", () => {
        const entry = makeEntry({ assignee: 'me@x.com' });
        expect(matchesCommentFilter(makeCard(), entry, filter({ assignee: 'me' }), 'ME@X.com')).toBe(true);
        expect(
            matchesCommentFilter(
                makeCard(),
                makeEntry({ assignee: 'other@x.com' }),
                filter({ assignee: 'me' }),
                'me@x.com',
            ),
        ).toBe(false);
        // Missing entry ⇒ assignee null ⇒ never "me".
        expect(matchesCommentFilter(makeCard(), undefined, filter({ assignee: 'me' }), 'me@x.com')).toBe(false);
    });

    test("'unassigned' matches null assignee, including unseeded (missing-entry) cards", () => {
        expect(matchesCommentFilter(makeCard(), undefined, filter({ assignee: 'unassigned' }), 'me@x.com')).toBe(true);
        expect(
            matchesCommentFilter(
                makeCard(),
                makeEntry({ assignee: null }),
                filter({ assignee: 'unassigned' }),
                'me@x.com',
            ),
        ).toBe(true);
        expect(
            matchesCommentFilter(
                makeCard(),
                makeEntry({ assignee: 'a@x.com' }),
                filter({ assignee: 'unassigned' }),
                'me@x.com',
            ),
        ).toBe(false);
    });

    test('{ email } compares against the stored (lowercased) value', () => {
        const entry = makeEntry({ assignee: 'alice@x.com' });
        expect(
            matchesCommentFilter(makeCard(), entry, filter({ assignee: { email: 'alice@x.com' } }), 'me@x.com'),
        ).toBe(true);
        expect(matchesCommentFilter(makeCard(), entry, filter({ assignee: { email: 'bob@x.com' } }), 'me@x.com')).toBe(
            false,
        );
        expect(
            matchesCommentFilter(makeCard(), undefined, filter({ assignee: { email: 'alice@x.com' } }), 'me@x.com'),
        ).toBe(false);
    });
});

describe('matchesCommentFilter — colors', () => {
    test('null colors matches any card color', () => {
        expect(matchesCommentFilter(makeCard({ color: '#f00' }), undefined, filter(), 'me@x.com')).toBe(true);
        expect(matchesCommentFilter(makeCard(), undefined, filter(), 'me@x.com')).toBe(true);
    });

    test("uncolored card matches Set([''])", () => {
        expect(matchesCommentFilter(makeCard(), undefined, filter({ colors: new Set(['']) }), 'me@x.com')).toBe(true);
        expect(
            matchesCommentFilter(makeCard({ color: '#f00' }), undefined, filter({ colors: new Set(['']) }), 'me@x.com'),
        ).toBe(false);
    });

    test('colored card matches its color', () => {
        expect(
            matchesCommentFilter(
                makeCard({ color: '#f00' }),
                undefined,
                filter({ colors: new Set(['#f00']) }),
                'me@x.com',
            ),
        ).toBe(true);
        expect(
            matchesCommentFilter(
                makeCard({ color: '#0f0' }),
                undefined,
                filter({ colors: new Set(['#f00']) }),
                'me@x.com',
            ),
        ).toBe(false);
    });
});

describe('matchesCommentFilter — combined', () => {
    test('all facets must pass', () => {
        const card = makeCard({ color: '#f00' });
        const entry = makeEntry({ status: 'open', assignee: 'me@x.com' });
        const f = filter({ status: 'open', assignee: 'me', colors: new Set(['#f00']) });
        expect(matchesCommentFilter(card, entry, f, 'me@x.com')).toBe(true);
        // One failing facet fails the whole match.
        expect(matchesCommentFilter(card, entry, { ...f, colors: new Set(['#0f0']) }, 'me@x.com')).toBe(false);
        expect(matchesCommentFilter(card, entry, { ...f, status: 'resolved' }, 'me@x.com')).toBe(false);
    });
});

describe('isCommentFilterActive', () => {
    test('false on the defaults instance', () => {
        expect(isCommentFilterActive(DEFAULT_COMMENT_FILTER, DEFAULT_COMMENT_FILTER)).toBe(false);
        const stickyDefaults = filter({ status: 'all' });
        expect(isCommentFilterActive(stickyDefaults, stickyDefaults)).toBe(false);
    });

    test('true after changing status', () => {
        expect(isCommentFilterActive(filter({ status: 'all' }), DEFAULT_COMMENT_FILTER)).toBe(true);
    });

    test('true after changing assignee (string and email cases)', () => {
        expect(isCommentFilterActive(filter({ assignee: 'me' }), DEFAULT_COMMENT_FILTER)).toBe(true);
        expect(isCommentFilterActive(filter({ assignee: { email: 'a@x.com' } }), DEFAULT_COMMENT_FILTER)).toBe(true);
    });

    test('email assignee equality is by value, not reference', () => {
        const defaults = filter({ assignee: { email: 'a@x.com' } });
        expect(isCommentFilterActive(filter({ assignee: { email: 'a@x.com' } }), defaults)).toBe(false);
        expect(isCommentFilterActive(filter({ assignee: { email: 'b@x.com' } }), defaults)).toBe(true);
    });

    test('true after changing colors; color equality is by contents', () => {
        expect(isCommentFilterActive(filter({ colors: new Set(['#f00']) }), DEFAULT_COMMENT_FILTER)).toBe(true);
        const defaults = filter({ colors: new Set(['#f00']) });
        expect(isCommentFilterActive(filter({ colors: new Set(['#f00']) }), defaults)).toBe(false);
        expect(isCommentFilterActive(filter({ colors: new Set(['#f00', '#0f0']) }), defaults)).toBe(true);
        expect(isCommentFilterActive(filter({ colors: null }), defaults)).toBe(true);
    });

    test('back to defaults reads inactive again', () => {
        const stickyDefaults = filter({ status: 'all' });
        const changed = filter({ status: 'all', assignee: 'me' });
        expect(isCommentFilterActive(changed, stickyDefaults)).toBe(true);
        // Resetting every facet to the defaults makes it inactive.
        expect(isCommentFilterActive({ ...stickyDefaults }, stickyDefaults)).toBe(false);
    });
});
