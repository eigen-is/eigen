import { describe, expect, test } from 'bun:test';
import { matchesCommentFilter, useCommentFilter } from '../../../core/comments/filter';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

type CommentFilter = Parameters<typeof matchesCommentFilter>[2];

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
        lastActivityAt: null,
        messageCount: 0,
        createdAt: new Date(0),
        assignee: null,
        title: null,
        ...overrides,
    };
}

function filter(overrides: Partial<CommentFilter> = {}): CommentFilter {
    return { assignee: 'all', colors: null, status: 'open', ...overrides };
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

describe('useCommentFilter', () => {
    // The hook as a host holds it: `current()` is the latest render, and `change` runs a setter inside act.
    async function mountFilter(defaults?: Partial<CommentFilter>) {
        const { act, createElement } = await import('react');
        const { createRoot } = await import('react-dom/client');
        const renders: ReturnType<typeof useCommentFilter>[] = [];
        function Harness() {
            renders.push(useCommentFilter(defaults));
            return null;
        }
        const root = createRoot(document.createElement('div'));
        await act(async () => root.render(createElement(Harness)));
        const current = () => {
            const latest = renders.at(-1);
            if (!latest) throw new Error('useCommentFilter never rendered');
            return latest;
        };
        return {
            current,
            change: (run: (filter: ReturnType<typeof useCommentFilter>) => void) => act(async () => run(current())),
            unmount: () => act(async () => root.unmount()),
        };
    }

    test('starts on open comments of every assignee and color, and is not active', async () => {
        const { current, unmount } = await mountFilter();
        expect(current().filter).toEqual({ assignee: 'all', colors: null, status: 'open' });
        expect(current().isActive).toBe(false);
        await unmount();
    });

    test("a host's own defaults are not an active filter", async () => {
        const { current, unmount } = await mountFilter({ status: 'all' });
        expect(current().filter.status).toBe('all');
        expect(current().isActive).toBe(false);
        await unmount();
    });

    test('is active after changing status', async () => {
        const { current, change, unmount } = await mountFilter();
        await change((filter) => filter.setStatus('all'));
        expect(current().isActive).toBe(true);
        await unmount();
    });

    test('is active after changing assignee (string and email cases)', async () => {
        const { current, change, unmount } = await mountFilter();
        await change((filter) => filter.setAssignee('me'));
        expect(current().isActive).toBe(true);
        await change((filter) => filter.setAssignee({ email: 'a@x.com' }));
        expect(current().isActive).toBe(true);
        await unmount();
    });

    test('email assignee equality is by value, not reference', async () => {
        const { current, change, unmount } = await mountFilter({ assignee: { email: 'a@x.com' } });
        await change((filter) => filter.setAssignee({ email: 'a@x.com' }));
        expect(current().isActive).toBe(false);
        await change((filter) => filter.setAssignee({ email: 'b@x.com' }));
        expect(current().isActive).toBe(true);
        await unmount();
    });

    test('is active after changing colors; color equality is by contents', async () => {
        const { current, change, unmount } = await mountFilter({ colors: new Set(['#f00']) });
        await change((filter) => filter.toggleColor('#0f0'));
        expect(current().isActive).toBe(true);
        await change((filter) => filter.toggleColor('#0f0'));
        expect(current().filter.colors).toEqual(new Set(['#f00']));
        expect(current().isActive).toBe(false);
        await change((filter) => filter.toggleColor('#f00'));
        expect(current().filter.colors).toBeNull();
        expect(current().isActive).toBe(true);
        await unmount();
    });

    test('clear goes back to the defaults and reads inactive again', async () => {
        const { current, change, unmount } = await mountFilter({ status: 'all' });
        await change((filter) => filter.setAssignee('me'));
        expect(current().isActive).toBe(true);
        await change((filter) => filter.clear());
        expect(current().filter).toEqual({ assignee: 'all', colors: null, status: 'all' });
        expect(current().isActive).toBe(false);
        await unmount();
    });
});
