// A scroll belongs to its page: the router puts scroll boxes back only when the path changes, never for a change of
// only the search, which a detail column's ?panel= or ?chat= is.
import { expect, test } from 'bun:test';
import { createRootRoute } from '@tanstack/react-router';
import { createEigenAppRouter } from '../../lib/eigenAppRouter';

test('scroll is restored on a path change and left alone on a search change', () => {
    const router = createEigenAppRouter({ routeTree: createRootRoute(), basepath: '/docs' });
    const { scrollRestoration } = router.options;
    if (typeof scrollRestoration !== 'function') throw new Error('scrollRestoration is not a function');
    const at = (pathname: string, search = '') =>
        scrollRestoration({
            location: router.parseLocation({
                pathname,
                search,
                hash: '',
                href: pathname + search,
                state: { __TSR_index: 0 },
            }),
        });
    expect(at('/docs/doc/a')).toBe(true);
    expect(at('/docs/doc/a', '?panel=comments')).toBe(false);
    expect(at('/docs/doc/a', '?panel=comments&chat=c')).toBe(false);
    expect(at('/docs')).toBe(true);
    expect(at('/docs/doc/a')).toBe(true);
});
